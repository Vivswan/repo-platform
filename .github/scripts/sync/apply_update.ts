#!/usr/bin/env bun
// Applies the template to the target checkout: a three-way `copier update`
// normally, or a full `copier recopy` in recovery mode - for a repo whose
// recorded _commit base is unusable, there is no merge base, so the
// re-render overwrites template-managed files outright (`_skip_if_exists`
// files survive; copier deletes nothing; the PR is forced onto the
// manual-review path). Invoked by reusable-template-sync.yml's "Apply
// copier update" step.
//
// Env: TARGET_DIR (default target), TARGET_REF, MODULES, PRIVATE,
// DESCRIPTION, RECOVER; SRC_PATH optional (where TARGET_REF resolves when
// the template source is a local clone other than the cwd - the
// rehearsal's).

import { statSync } from "node:fs";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { capture, passthrough } from "../shared/proc.ts";
import { AnswersFileError, readAnswersFile, recordedCommitMismatch } from "./answers_file.ts";

const targetDir = env("TARGET_DIR", "target");
const targetRef = requireEnv("TARGET_REF");

/** The commit TARGET_REF names, resolved in the first repository that
 * knows it: SRC_PATH, the answers file's `_src_path` when that is a local
 * directory (the harness and the rehearsal point it at their build clone),
 * then the cwd (the sync's checkout, where resolve_refs fetched the build
 * branch). The production ref is already a sha and resolves anywhere it
 * exists; a tag or branch name (the harnesses) resolves only where it
 * lives. */
function targetSha(): string {
  const candidates = [env("SRC_PATH"), recordedSrcPath(), "."].filter((dir) => dir !== "");
  for (const dir of candidates) {
    const probe = capture([
      "git",
      "-C",
      dir,
      "rev-parse",
      "--verify",
      "--quiet",
      `${targetRef}^{commit}`,
    ]);
    if (probe.exitCode === 0) return probe.stdout.trimEnd();
    // --verify --quiet exits 1 for a ref the repository does not have;
    // anything else (128: not a repository, unreadable) is a failure to
    // look, not absence, and must not fall through to the next candidate.
    if (probe.exitCode !== 1) {
      fail(
        `git rev-parse failed in ${dir} (exit ${probe.exitCode}) while resolving TARGET_REF '${targetRef}': ${probe.stderr.trim()}`,
      );
    }
  }
  return fail(
    `cannot resolve TARGET_REF '${targetRef}' to a commit in ${candidates.join(", ")}, so the recorded _commit cannot be verified`,
  );
}

function recordedSrcPath(): string {
  let value: unknown;
  try {
    value = readAnswersFile(targetDir).fields._src_path;
  } catch (err) {
    // A file the boundary refuses or cannot shape is no candidate; a
    // failure to LOOK (EACCES, EIO) is not absence and propagates.
    if (err instanceof AnswersFileError) return "";
    throw err;
  }
  if (typeof value !== "string") return "";
  try {
    return statSync(value).isDirectory() ? value : "";
  } catch (err) {
    // Only "nothing at this path" is absence (a remote _src_path like
    // gh:o/r is the common case); any other lookup failure propagates.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "";
    throw err;
  }
}

const subcommand = env("RECOVER") === "recopy" ? ["recopy", "--overwrite"] : ["update"];
const exitCode = passthrough(
  [
    "copier",
    ...subcommand,
    // Where copier READS the recorded answers as well as writes them:
    // the subproject read honors only this flag or the hardcoded root
    // default - never the template's _answers_file - so every update
    // and recopy must name the landed path explicitly (measured on
    // copier 9.17.0; relocate_answers.ts moved a pre-move target's file
    // here before this runs).
    "--answers-file",
    ".github/.copier-answers.yml",
    "--vcs-ref",
    targetRef,
    "--defaults",
    "--trust",
    "-d",
    `modules=${requireEnv("MODULES")}`,
    "-d",
    `private=${requireEnv("PRIVATE")}`,
    "-d",
    `description=${env("DESCRIPTION")}`,
  ],
  { cwd: targetDir },
);
if (exitCode !== 0) process.exit(exitCode);
// Postcondition on what the render WROTE: the template's stamp hook must
// have recorded the exact commit copier rendered, or every 40-hex reader
// of _commit downstream would fail on this repo.
let recorded = "";
try {
  recorded = readAnswersFile(targetDir).commit;
} catch (err) {
  // The boundary's refusals read as "no readable _commit" (the mismatch
  // names the file); an I/O failure is not that and propagates.
  if (!(err instanceof AnswersFileError)) throw err;
}
const mismatch = recordedCommitMismatch(recorded, targetSha());
if (mismatch !== null) fail(mismatch);
