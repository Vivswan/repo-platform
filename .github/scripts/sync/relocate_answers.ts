#!/usr/bin/env bun
// One-shot fleet transition (answers-file move): the recorded answers file
// leaves the repository root - a fleet repo's root carries only its own
// content plus .repo-platform.yml - for .github/.copier-answers.yml, where
// the template now renders it (_answers_file in copier.yml). A pre-move
// target is moved byte-for-byte with `git mv` and committed BEFORE any
// step reads the answers and before copier runs (copier update refuses a
// dirty tree, and every copier invocation passes the new path via
// --answers-file, which is both where copier reads the recorded answers
// and where it writes them - measured on copier 9.17.0: the subproject
// read honors only the CLI flag or the hardcoded root default, never the
// new template version's _answers_file). The bytes are load-bearing: the
// old-render replay (clean_renders.ts) feeds the recorded scalars to
// copier verbatim, and only the move's rename must ride this commit (the
// commit is pathspec-limited to the two answers paths).
//
// This script is the single owner of the answers file's location: a
// target carrying the file at BOTH paths, at NEITHER, or as anything but
// a regular file fails loudly here (no reader downstream re-litigates the
// question). Self-retiring: once the fleet has crossed, the legacy path
// never exists and the move never fires - delete the transition arm (and
// this note) then.
//
// Value-free by construction: both paths are template knowledge, never
// target content, so every message is safe for a public log.
//
// Invoked by reusable-template-sync.yml right after the registration
// check (TARGET_DIR default "target"; RUNNER_TEMP for the PR-body note)
// and replayed by rehearse.ts in the same slot.

import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, error, notice, requireEnv } from "../shared/gha.ts";
import { identityArgs, SYNC_IDENTITY } from "../shared/git_identity.ts";
import { must } from "../shared/proc.ts";
import { ANSWERS_MOVE_NAME } from "./section_files.ts";

/** The answers file's canonical landed path (copier.yml `_answers_file`). */
export const ANSWERS_PATH = ".github/.copier-answers.yml";

/** The retired pre-move path (answers at the repository root). */
export const LEGACY_ANSWERS_PATH = ".copier-answers.yml";

export type AnswersLocation = "in-place" | "moved" | "missing" | "both" | "not-a-file";

/** What sits at `path`: a regular file, nothing, or something else -
 * probed with lstat so a symlink never reads as the file it points at.
 * ENOENT is genuine absence; ENOTDIR means a parent segment is itself a
 * file (a `.github` FILE, say), which is the same broken shape as a
 * non-file entry; anything else (EACCES, EIO) throws - a permission
 * failure must never read as "absent". */
function entryKind(path: string): "file" | "absent" | "other" {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    if (code === "ENOTDIR") return "other";
    throw err;
  }
  return stat.isFile() ? "file" : "other";
}

/** Where the target keeps its recorded answers, moving a legacy-path file
 * to ANSWERS_PATH (bytes untouched - `git mv` renames the blob) and
 * committing the move so copier sees a clean tree. Pure probe otherwise. */
export function relocateAnswers(targetDir: string): AnswersLocation {
  const legacy = entryKind(join(targetDir, LEGACY_ANSWERS_PATH));
  const current = entryKind(join(targetDir, ANSWERS_PATH));
  if (legacy === "other" || current === "other") return "not-a-file";
  if (legacy === "file" && current === "file") return "both";
  if (legacy === "absent" && current === "absent") return "missing";
  if (current === "file") return "in-place";
  // Every fleet repo carries .github/ (its workflows live there), but a
  // bare mkdir keeps the move total rather than order-dependent.
  mkdirSync(join(targetDir, ".github"), { recursive: true });
  must(["git", "-C", targetDir, "mv", LEGACY_ANSWERS_PATH, ANSWERS_PATH]);
  // Pathspec-limited: ONLY the rename rides this commit, whatever else the
  // index happens to hold - anything unrelated stays behind and fails
  // loudly at copier's own dirty-tree check instead of smuggling through.
  must([
    "git",
    "-C",
    targetDir,
    ...identityArgs(SYNC_IDENTITY),
    "commit",
    "-qm",
    `chore: move the copier answers file to ${ANSWERS_PATH}`,
    "--",
    LEGACY_ANSWERS_PATH,
    ANSWERS_PATH,
  ]);
  return "moved";
}

/** The PR-body note for the one-time move; "" when nothing moved. */
export function answersMoveNote(location: AnswersLocation): string {
  if (location !== "moved") return "";
  return [
    "> [!NOTE]",
    `> ANSWERS FILE MOVE: this update moves \`${LEGACY_ANSWERS_PATH}\` to`,
    `> \`${ANSWERS_PATH}\`, byte-for-byte - the recorded answers ride the move`,
    "> verbatim, and copier reads and writes only the new path from now on.",
    "> One-time transition: the repository root keeps only repo content plus",
    "> `.repo-platform.yml`; platform-generated machinery lives under `.github/`.",
    "",
  ].join("\n");
}

function main(): number {
  const targetDir = env("TARGET_DIR", "target");
  const display = env("TARGET_DISPLAY");
  const location = relocateAnswers(targetDir);
  writeFileSync(
    join(requireEnv("RUNNER_TEMP"), ANSWERS_MOVE_NAME),
    answersMoveNote(location),
    "utf-8",
  );
  // The regenerate advice is `copier copy`, not recover=recopy: this step
  // runs BEFORE recovery mode reaches copier, and recopy itself needs a
  // readable answers file - a recopy dispatch would just fail here again.
  const regenerate =
    "regenerate the repo with 'copier copy gh:" +
    `${env("GITHUB_REPOSITORY", "Vivswan/repo-platform")} . --vcs-ref build'`;
  switch (location) {
    case "in-place":
      console.log(`answers file already at ${ANSWERS_PATH}; nothing to move`);
      return 0;
    case "moved":
      notice(
        `${display}: moved ${LEGACY_ANSWERS_PATH} to ${ANSWERS_PATH} (bytes unchanged; ` +
          "one-time transition, committed onto the update branch) - the PR body carries the note.",
      );
      return 0;
    case "both":
      error(
        `${display} carries a copier answers file at BOTH ${ANSWERS_PATH} and the retired ` +
          `root path ${LEGACY_ANSWERS_PATH}. The sync reads only ${ANSWERS_PATH}; delete the ` +
          "stale root copy on the default branch, then re-run the sync.",
      );
      return 1;
    case "missing":
      error(
        `${display} has no ${ANSWERS_PATH} on its default branch, so copier has no recorded ` +
          `answers to update from. Restore the file from git history, or ${regenerate}.`,
      );
      return 1;
    case "not-a-file":
      error(
        `${display} carries something other than a regular file at ${ANSWERS_PATH} or ` +
          `${LEGACY_ANSWERS_PATH} (a directory or a symlink). The sync refuses to guess: fix ` +
          `the default branch by hand, or ${regenerate}.`,
      );
      return 1;
  }
}

if (import.meta.main) {
  process.exit(main());
}
