#!/usr/bin/env bun
// Local rehearsal of one managed repo's sync PR: clones the target shallow
// into /tmp, assembles a build tree from THIS working tree (uncommitted
// template changes included), commits it as a synthetic build chained onto
// the target's recorded _commit, and runs the legs
// reusable-template-sync.yml runs - module selection, copier update,
// clean-render materialization, the split-file structural rebuild,
// conflict resolution (rebuilt files skipped), retired-file cleanup, the
// repo-owned preserve step, the final manifest stamp, the manifest license
// check, and validation - then prints the resulting diff and the would-be
// PR-body sections.
//
// READ-ONLY against the remote: the network is touched only to clone the
// target, fetch this repo's build refs, and (first run) install the
// validator's dependencies. Right after cloning, the target's origin URLs
// (fetch and push) are pointed at an unroutable value, so any remote
// operation through the clone's remote fails loudly. Network git calls run
// with prompts disabled and a hard deadline, so a stalled network or a
// credential prompt becomes a loud, fast failure instead of a hang. The
// code that runs with --trust is this repository's own template - the same
// trust the real sync extends - and nothing here opens PRs or writes to
// any remote. The workspace under /tmp is left in place for inspection.
//
// The CLI below rehearses one repo; rehearse_fleet.ts drives the exported
// rehearseRepo across every managed repo (quiet, workspace cleaned up) and
// turns thrown RehearsalErrors into report rows instead of aborts.
//
// Known parity gaps vs the workflow (this is an operator convenience, not
// a second pipeline): live visibility/description come from the recorded
// copier answers instead of the GitHub API, so out-of-band settings drift
// is not rehearsed; token-scope workflow withholding, hide-details
// redaction, and the PR/auto-merge machinery do not apply locally; and
// validation uses this working tree's validator, not a version-aligned
// release checkout - which is the point when rehearsing unreleased changes.
//
// Usage:
//   bun .github/scripts/sync/rehearse.ts <owner>/<repo>

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { loadRegistry } from "../fleet/repos_registry.ts";
import { capture, passthrough, type RunOptions, type RunResult } from "../shared/proc.ts";
import { AnswersFileError, readAnswersFile } from "./answers_file.ts";
import { rewriteSrcPath } from "./src_path.ts";
import { MANIFEST_NAME, stampManifestText } from "./stamp_manifest.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const REHEARSAL_TAG = "rehearsal-build";
// Fresh clones have no committer identity configured.
const GIT_IDENT = ["-c", "user.name=rehearsal", "-c", "user.email=rehearsal@localhost"];

/** Hard deadline for the network calls (the target clone, the build-ref
 * fetches, the fleet mode's visibility lookups): generous next to a real
 * shallow clone, tiny next to a hung credential prompt. */
export const NETWORK_TIMEOUT_MS = 300_000;

// Empty GIT_ASKPASS/SSH_ASKPASS fall through to the terminal prompt, which
// GIT_TERMINAL_PROMPT=0 disables - a set GIT_ASKPASS (VS Code exports one)
// would otherwise intercept a 401 and hang or misbehave.
const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };

/** A rehearsal that cannot proceed for this repo; the message is a
 * one-line reason fit for a fleet report row. */
export class RehearsalError extends Error {}

/** The target's recorded _commit does not resolve: the real sync would
 * need recover=recopy, which the rehearsal does not model. */
export class RecoveryNeededError extends RehearsalError {}

/** The target has not adopted the template (no .repo-platform.yml on its
 * default branch); production's selector skips these, so the fleet report
 * files them as skips, not failures. */
export class NotManagedError extends RehearsalError {}

export interface ConflictedFile {
  file: string;
  hunks: number;
}

export type ManifestStatus = "stamped" | "stale" | "missing" | "unparseable";

export interface RehearsalOutcome {
  /** The would-be sync PR is non-empty. */
  changed: boolean;
  conflicts: ConflictedFile[];
  /** Files whose conflict markers were malformed and left unresolved. */
  malformed: string[];
  /** Retired files the update deletes. */
  retired: number;
  manifest: ManifestStatus;
  validationOk: boolean;
  /** The /tmp workspace, or null when the rehearsal removed it. */
  workspace: string | null;
}

export interface RehearsalOptions {
  /** Print sections, subprocess output, the diff, and the would-be PR
   * body (the single-repo CLI); false is the fleet mode's quiet run. */
  verbose: boolean;
  /** Leave the /tmp workspace in place for inspection. */
  keepWorkspace: boolean;
}

/** One-line label for a failed command: the bun script's basename, "git
 * <subcommand>", or the bare executable. */
function describeCommand(command: string[]): string {
  if (command[0] === "bun") {
    const script = command.find((arg) => arg.endsWith(".ts"));
    if (script !== undefined) return script.split("/").pop() ?? script;
    return command.slice(0, 2).join(" ");
  }
  if (command[0] === "git") {
    for (let i = 1; i < command.length; i++) {
      if (command[i].startsWith("-")) {
        if (command[i] === "-C" || command[i] === "-c") i++;
        continue;
      }
      return `git ${command[i]}`;
    }
  }
  return command[0];
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

/** Subprocess runners that throw RehearsalError instead of exiting, so the
 * fleet loop can continue past a failing repo. Verbose forwards child
 * output; quiet keeps it for the failure reason only. */
function makeRunner(verbose: boolean) {
  const check = (command: string[], result: RunResult, forward: boolean): void => {
    if (result.exitCode === 0) return;
    if (forward) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    if (result.timedOut === true) {
      throw new RehearsalError(
        `${describeCommand(command)} timed out after ${NETWORK_TIMEOUT_MS}ms (stalled network?)`,
      );
    }
    const tail = lastLine(result.stderr + result.stdout);
    throw new RehearsalError(
      `${describeCommand(command)} failed (exit ${result.exitCode})${tail === "" ? "" : `: ${tail}`}`,
    );
  };
  const runCaptured = (command: string[], options: RunOptions = {}): RunResult => {
    const result = capture(command, options);
    check(command, result, verbose);
    return result;
  };
  const run = (command: string[], options: RunOptions = {}): void => {
    // passthrough cannot enforce a deadline, so deadlined calls capture.
    if (verbose && options.timeoutMs === undefined) {
      check(command, { exitCode: passthrough(command, options), stdout: "", stderr: "" }, false);
      return;
    }
    const result = runCaptured(command, options);
    if (verbose) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
  };
  return { run, runCaptured };
}

/** The per-file lines of resolve_copier_conflicts.ts's stdout, parsed into
 * structure. Parsing stops at the first "#### " line: the full markdown
 * summary dumped after the per-file lines quotes dropped hunk content,
 * which could contain look-alike lines. */
export function parseConflictReport(stdout: string): {
  conflicts: ConflictedFile[];
  malformed: string[];
} {
  const conflicts: ConflictedFile[] = [];
  const malformed: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("#### ")) break;
    const resolved = /^(.+): resolved (\d+) conflict\(s\) toward the template/.exec(line);
    if (resolved !== null) {
      conflicts.push({ file: resolved[1], hunks: Number(resolved[2]) });
      continue;
    }
    const untouched = /^(.+): malformed or out-of-order conflict markers, left untouched$/.exec(
      line,
    );
    if (untouched !== null) malformed.push(untouched[1]);
  }
  return { conflicts, malformed };
}

/** Whether the target tree's ownership manifest is honestly stamped:
 * "stale" means stampManifestText would still rewrite it (a hash or the
 * provenance commit disagrees with the tree on disk). */
export function manifestStatus(root: string): ManifestStatus {
  let text: string;
  try {
    text = readFileSync(join(root, MANIFEST_NAME), "utf-8");
  } catch {
    return "missing";
  }
  const { out, problem } = stampManifestText(text, root);
  if (problem !== null) return "unparseable";
  return out === text ? "stamped" : "stale";
}

// Warns when repos.yml would never sync this repo (production's full
// selection needs the fleet PAT's repo discovery - the managed wildcard -
// which does not exist locally, so a repo production would skip is warned
// about and rehearsed anyway: a read-only what-if against an excluded repo
// is a legitimate rehearsal).
function warnUnselected(slug: string): void {
  const { registry, errors } = loadRegistry(readFileSync(join(REPO_ROOT, "repos.yml"), "utf-8"));
  if (registry === null) throw new RehearsalError(`repos.yml: ${errors.join("; ")}`);
  const lower = slug.toLowerCase();
  if (registry.exclude.some((entry) => entry.toLowerCase() === lower)) {
    console.warn(`warning: ${slug} is in repos.yml's exclude list; production never syncs it`);
  } else if (
    !registry.managed.wildcard &&
    !registry.managed.repos.some((entry) => entry.toLowerCase() === lower)
  ) {
    console.warn(`warning: ${slug} is not in repos.yml's managed list; production never syncs it`);
  }
}

/** Rehearse one repo's sync end to end (see the file header for the legs
 * and the read-only guarantees). Throws RehearsalError on any condition
 * that stops the rehearsal - RecoveryNeededError for the unresolvable
 * recorded _commit - never process.exit, so the fleet loop survives it. */
export function rehearseRepo(slug: string, options: RehearsalOptions): RehearsalOutcome {
  const { verbose, keepWorkspace } = options;
  const say = (line: string): void => {
    if (verbose) console.log(line);
  };
  const section = (title: string): void => {
    say(`\n=== ${title} ===`);
  };
  const { run, runCaptured } = makeRunner(verbose);
  // Raw stdout, never trimmed: the copier.yml snapshots must stay
  // byte-for-byte, trailing newline included (resolve_refs.ts does the same).
  const gitShow = (repo: string, revPath: string): string =>
    runCaptured(["git", "-C", repo, "show", revPath]).stdout;

  if (Bun.which("copier") === null) {
    throw new RehearsalError(
      "copier is not on PATH (pipx install copier); the rehearsal runs real copier updates",
    );
  }

  const work = mkdtempSync(`/tmp/rehearse-${slug.replace("/", "-")}-`);
  try {
    const targetDir = join(work, "target");
    const platformDir = join(work, "platform");
    const buildDir = join(work, "build-tree");
    const temp = join(work, "temp");
    mkdirSync(temp);

    section(`cloning ${slug} (shallow, read-only)`);
    say(`workspace: ${work}`);
    // A public-repo clone wants no credentials, so the helper is cleared
    // outright; with prompts disabled too, nothing here can stall on auth.
    run(
      [
        "git",
        "-c",
        "credential.helper=",
        "clone",
        "--quiet",
        "--depth",
        "1",
        `https://github.com/${slug}.git`,
        targetDir,
      ],
      { env: NO_PROMPT_ENV, timeoutMs: NETWORK_TIMEOUT_MS },
    );
    // The read-only assertion: nothing after the clone may reach the target's
    // remote, so both URLs go unroutable - a fetch or push through the
    // clone's remote fails loudly instead of touching GitHub.
    for (const kind of [[], ["--push"]]) {
      run([
        "git",
        "-C",
        targetDir,
        "remote",
        "set-url",
        ...kind,
        "origin",
        "read-only-rehearsal://never-touch",
      ]);
    }
    const origHead = runCaptured(["git", "-C", targetDir, "rev-parse", "HEAD"]).stdout.trim();

    if (!existsSync(join(targetDir, ".repo-platform.yml"))) {
      throw new NotManagedError(
        `${slug} is not managed by repo-platform: .repo-platform.yml is missing from its default branch`,
      );
    }
    // Adopted but broken is a failure, not a skip: production's selector
    // only gates on .repo-platform.yml, and the sync leg would fail here.
    if (!existsSync(join(targetDir, ".copier-answers.yml"))) {
      throw new RehearsalError(
        `${slug} has .repo-platform.yml but no .copier-answers.yml; the sync cannot update it`,
      );
    }
    let answers: ReturnType<typeof readAnswersFile>;
    try {
      answers = readAnswersFile(join(targetDir, ".copier-answers.yml"));
    } catch (err) {
      if (!(err instanceof AnswersFileError)) throw err;
      throw new RehearsalError(`${slug}'s .copier-answers.yml: ${err.message}`);
    }
    warnUnselected(slug);
    if (answers.commit === "") {
      throw new RehearsalError(
        `${slug}'s .copier-answers.yml records no _commit; there is no base to update from`,
      );
    }
    // Recorded answers stand in for the workflow's live API read (parity gap
    // in the header): the render still gets real per-repo values.
    const privateAnswer = answers.fields.private === true ? "true" : "false";
    const description =
      typeof answers.fields.description === "string" ? answers.fields.description : "";

    section("fetching build refs and assembling the rehearsal release");
    run(["git", "init", "--quiet", platformDir]);
    const originUrl = runCaptured([
      "git",
      "-C",
      REPO_ROOT,
      "remote",
      "get-url",
      "origin",
    ]).stdout.trim();
    // The build ref lives only on origin, never in this checkout; main
    // rides along because legacy repos record a plain main-history _commit
    // (the workflow checks out full history for the same reason).
    // Best-effort per ref: a fleet missing one of them can still rehearse
    // as long as _commit resolves. The credential helper stays (a private
    // origin may legitimately need it); prompts are off and the deadline
    // turns a stall into a fast failure.
    const fetches = [
      "+refs/heads/main:refs/heads/main",
      "+refs/heads/template:refs/heads/template",
    ].map((refspec) =>
      capture(["git", "-C", platformDir, "fetch", "--quiet", originUrl, refspec], {
        env: NO_PROMPT_ENV,
        timeoutMs: NETWORK_TIMEOUT_MS,
      }),
    );
    // One failed ref is normal (best-effort, above), but a timeout or a
    // failure of every ref is a network problem, and the _commit probe
    // below must not mislabel that as recovery-needed.
    if (fetches.some((fetch) => fetch.timedOut === true)) {
      throw new RehearsalError(
        `fetching build refs from ${originUrl} timed out after ${NETWORK_TIMEOUT_MS}ms (stalled network?)`,
      );
    }
    if (fetches.every((fetch) => fetch.exitCode !== 0)) {
      throw new RehearsalError(
        `fetching build refs from ${originUrl} failed: ${lastLine(fetches[fetches.length - 1].stderr)}`,
      );
    }
    const oldShaProbe = capture([
      "git",
      "-C",
      platformDir,
      "rev-parse",
      "--verify",
      "--quiet",
      `${answers.commit}^{commit}`,
    ]);
    if (oldShaProbe.exitCode !== 0) {
      throw new RecoveryNeededError(
        `${slug}'s recorded _commit '${answers.commit}' does not resolve on ${originUrl}'s build refs or main history; ` +
          "the real sync would need recover=recopy, which this rehearsal does not model",
      );
    }
    const oldSha = oldShaProbe.stdout.trim();

    run(["bun", ".github/scripts/build-branches/branch_tree.ts", "--dest", buildDir], {
      cwd: REPO_ROOT,
    });
    // Chain the rehearsal build onto the recorded base, mirroring the real
    // append-only build branches (ci/upgrade_path_test.sh does the same):
    // copier's downgrade check orders unparseable refs by dunamai's
    // commit-count fallback, so the new commit must descend from the old.
    capture(["git", "-C", platformDir, "tag", "-d", REHEARSAL_TAG]);
    run(["git", "-C", platformDir, "checkout", "--quiet", "--detach", oldSha]);
    for (const entry of readdirSync(platformDir)) {
      if (entry !== ".git") rmSync(join(platformDir, entry), { recursive: true, force: true });
    }
    cpSync(buildDir, platformDir, { recursive: true });
    run(["git", "-C", platformDir, "add", "-A"]);
    run([
      "git",
      "-C",
      platformDir,
      ...GIT_IDENT,
      "commit",
      "--quiet",
      "-m",
      `build(rehearsal): ${REHEARSAL_TAG}`,
    ]);
    run(["git", "-C", platformDir, "tag", REHEARSAL_TAG]);

    // The sync's own normalization (sync/src_path.ts's rewrite), pointed at
    // the local build instead of the canonical source; committed because
    // copier update needs a clean tree (the real sync commits its
    // normalization too).
    const answersPath = join(targetDir, ".copier-answers.yml");
    const rewrite = rewriteSrcPath(readFileSync(answersPath, "utf-8"), platformDir);
    if (rewrite === null) {
      throw new RehearsalError(`no _src_path line in ${answersPath}`);
    }
    writeFileSync(answersPath, rewrite.rewritten);
    run([
      "git",
      "-C",
      targetDir,
      ...GIT_IDENT,
      "commit",
      "--quiet",
      "-am",
      "rehearsal: point _src_path at the local build",
    ]);

    section("selecting modules");
    // modules.ts prints its ::error:: detail on stdout (where workflow
    // commands parse); the runner forwards both streams on failure.
    const selection = runCaptured(
      [
        "bun",
        ".github/scripts/sync/modules.ts",
        "--repo-file",
        join(targetDir, ".repo-platform.yml"),
        "--template-copier",
        join(buildDir, "copier.yml"),
        "--retired-summary",
        join(temp, "retired-modules.txt"),
      ],
      { cwd: REPO_ROOT },
    );
    const modules = selection.stdout.replace(/\n+$/, "");
    say(`selected modules: ${modules}`);

    const legEnv = {
      TARGET_DIR: targetDir,
      TARGET_REF: REHEARSAL_TAG,
      MODULES: modules,
      PRIVATE: privateAnswer,
      DESCRIPTION: description,
      RUNNER_TEMP: temp,
      SRC_PATH: platformDir,
      OLD_SHA: oldSha,
      RECOVER: "",
    };

    section("copier update");
    run(["bun", ".github/scripts/sync/apply_update.ts"], { cwd: REPO_ROOT, env: legEnv });

    // The workflow's leg order: materialize the clean renders, rebuild the
    // split files structurally, then resolve leftover conflicts with the
    // rebuilt files excluded - rehearsal must exercise exactly what
    // production runs, or it drops split-file content production preserves
    // (false red) and hides real rebuild bugs (false green).
    section("clean renders + split-file structural rebuild");
    run(["bun", ".github/scripts/sync/clean_renders.ts"], { cwd: REPO_ROOT, env: legEnv });
    run(
      [
        "bun",
        ".github/scripts/sync/preserve_local_content.ts",
        "--summary",
        join(temp, "local-carryover.md"),
        "--root",
        targetDir,
        "--needs-review",
        join(temp, "carry-review.txt"),
        "--rebuilt-paths",
        join(temp, "split-rebuilt-paths.txt"),
        "--render-dir",
        join(temp, "render-new"),
        "--old-render-dir",
        join(temp, "render-old"),
      ],
      { cwd: REPO_ROOT, env: legEnv },
    );
    // Captured in both modes: the per-file lines carry the conflict report.
    const resolution = runCaptured(
      [
        "bun",
        ".github/scripts/sync/resolve_copier_conflicts.ts",
        "--summary",
        join(temp, "dropped-local-hunks.md"),
        "--root",
        targetDir,
        "--skip",
        join(temp, "split-rebuilt-paths.txt"),
      ],
      { cwd: REPO_ROOT },
    );
    if (verbose) {
      process.stdout.write(resolution.stdout);
      process.stderr.write(resolution.stderr);
    }
    const { conflicts, malformed } = parseConflictReport(resolution.stdout);

    section("retired-file cleanup");
    writeFileSync(join(temp, "copier-old.yml"), gitShow(platformDir, `${oldSha}:copier.yml`));
    writeFileSync(
      join(temp, "copier-new.yml"),
      gitShow(platformDir, `${REHEARSAL_TAG}:copier.yml`),
    );
    run(["bun", ".github/scripts/sync/retired_cleanup.ts"], { cwd: REPO_ROOT, env: legEnv });
    const removedPath = join(temp, "removed-paths.txt");
    const retired = existsSync(removedPath)
      ? readFileSync(removedPath, "utf-8")
          .split("\n")
          .filter((line) => line !== "").length
      : 0;

    // cwd is the platform repo: the preserve step's fleet-license re-seed
    // resolves TARGET_REF in the cwd's git repository, and the rehearsal tag
    // exists only there.
    run(["bun", join(import.meta.dir, "preserve_repo_owned.ts")], {
      cwd: platformDir,
      env: legEnv,
    });
    // Conflict resolution and the preserve steps can rewrite files after
    // copier's post-render stamp hook ran, so the manifest is stamped once
    // more when the tree is final - the same final stamping step
    // reusable-template-sync.yml runs (idempotent; see stamp_manifest.ts).
    run(["bun", join(import.meta.dir, "stamp_manifest.ts")], { cwd: REPO_ROOT, env: legEnv });
    const manifest = manifestStatus(targetDir);
    run(["bun", join(import.meta.dir, "manifest_license_check.ts")], {
      cwd: REPO_ROOT,
      env: legEnv,
    });

    section("validating the updated tree");
    // First run reaches the network for packages, so it gets the deadline.
    run(["bun", "install", "--frozen-lockfile", "--silent"], {
      cwd: join(REPO_ROOT, "actions/validate-template"),
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    // A failure prints its diagnostics but does not stop the rehearsal: the
    // sync opens the PR on failed validation too, and the diff below is what
    // the operator came for. The outcome carries the verdict.
    const validator = [
      "bun",
      join(REPO_ROOT, "actions/validate-template/validate_generated_files.ts"),
      targetDir,
    ];
    const validationOk = verbose ? passthrough(validator) === 0 : capture(validator).exitCode === 0;

    run(["git", "-C", targetDir, "add", "-A"]);
    const changed =
      capture(["git", "-C", targetDir, "diff", "--cached", "--quiet", origHead]).exitCode !== 0;

    if (verbose) {
      section("resulting diff (the would-be sync PR)");
      if (!changed) {
        console.log("no changes: the target already matches the rehearsal build");
      } else {
        passthrough(["git", "-C", targetDir, "diff", "--cached", "--stat", origHead]);
        passthrough(["git", "-C", targetDir, "diff", "--cached", origHead]);
      }

      section("would-be PR-body sections");
      const prSections: [string, string][] = [
        ["retired-modules.txt", "Retired modules dropped from the selection"],
        ["removed-paths.txt", "The template retired these files; this update deletes them"],
        ["local-carryover.md", "Split-file carry summary (rebuilt structurally)"],
        ["carry-review.txt", "Split-file carries needing review (the PR would stay manual-review)"],
        [
          "dropped-local-hunks.md",
          "Merge conflicts resolved toward the template (review the dropped local lines)",
        ],
        [
          "license-transition.txt",
          "License files this update deletes (the PR would stay manual-review)",
        ],
        ["manifest-license-warnings.md", "Registry metadata conflicting with the fleet license"],
      ];
      let anySection = false;
      for (const [file, title] of prSections) {
        const path = join(temp, file);
        if (existsSync(path) && statSync(path).size > 0) {
          anySection = true;
          console.log(`\n--- ${title} ---`);
          console.log(readFileSync(path, "utf-8").replace(/\n$/, ""));
        }
      }
      if (!anySection) console.log("(none - nothing here would hold the PR for review)");

      section("rehearsal summary");
      console.log(`validation: ${validationOk ? "ok" : "FAILED (diagnostics above)"}`);
      console.log(`ownership manifest: ${manifest}`);
      if (keepWorkspace) console.log(`workspace kept for inspection: ${work}`);
      console.log(
        "note: the diff's _src_path points at the rehearsal build (the real sync writes the " +
          "canonical source), and live visibility/description came from the recorded answers, " +
          "so out-of-band settings drift is not rehearsed.",
      );
    }

    return {
      changed,
      conflicts,
      malformed,
      retired,
      manifest,
      validationOk,
      workspace: keepWorkspace ? work : null,
    };
  } finally {
    if (!keepWorkspace) rmSync(work, { recursive: true, force: true });
  }
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function main(): number {
  const slug = process.argv[2];
  if (
    slug === undefined ||
    process.argv.length > 3 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)
  ) {
    fail("usage: bun .github/scripts/sync/rehearse.ts <owner>/<repo>");
  }
  try {
    return rehearseRepo(slug, { verbose: true, keepWorkspace: true }).validationOk ? 0 : 1;
  } catch (err) {
    if (!(err instanceof RehearsalError)) throw err;
    fail(err.message);
  }
}

if (import.meta.main) {
  process.exit(main());
}
