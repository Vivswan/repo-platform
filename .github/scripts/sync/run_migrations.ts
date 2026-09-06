#!/usr/bin/env bun
// Runs the migration ladder's pending rungs before copier updates the
// target (docs/migrations.md). A rung is a self-contained file at
// migrations/mNNNN_<slug>.ts on the build branch and is its own marker:
// pending = every rung file present in any build commit in (old, new]
// that old's tree lacks, in filename order, each loaded from the NEWEST
// build commit that carries it - so a rung pruned from main after a
// repository fell behind still runs, from history. No usable base (OLD_SHA
// "") runs every rung on the delivered tree; each rung is idempotent.
//
// The runner owns the git side: it requires a clean checkout, commits
// what a rung staged as the sync identity after each verdict, and stops
// at the first error arm. Env: TARGET_DIR (default target), TARGET_DISPLAY,
// PLATFORM_DIR (default "."), OLD_SHA ("" = no base), TARGET_REF, RUNNER_TEMP.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { env, error, hideDetails, notice, requireEnv } from "../shared/gha.ts";
import { identityArgs, SYNC_IDENTITY } from "../shared/git_identity.ts";
import { capture } from "../shared/proc.ts";
import { FULL_SHA_RE } from "./recorded_commit.ts";
import { MIGRATIONS_NAME, MIGRATIONS_REVIEW_NAME } from "./section_files.ts";

/** The build tree's rung directory: plain filenames outside template/, so
 * copier never renders them and a `uses:` tarball extracts them cleanly. */
export const MIGRATIONS_DIR = "migrations";

/** A rung id: `mNNNN_<slug>`, four zero-padded digits so filename order is
 * ladder order. One body, two matchers: the filename test below and the
 * ssot rules' whole-token scans derive from it. */
export const RUNG_ID_BODY = String.raw`m\d{4}(?:_[a-z0-9]+)+`;
export const RUNG_FILE_RE = new RegExp(`^(${RUNG_ID_BODY})\\.ts$`);

/** What a rung sees of the target: the checkout and the two shas the walk
 * compared (old null when the target has no usable base). */
export interface RungTarget {
  readonly dir: string;
  readonly oldSha: string | null;
  readonly newSha: string;
}

/** A rung's PR-body text for its verdict; `review` true holds the PR for a
 * human (open_pr.ts's manual-review path), false is informational. */
export interface RungNote {
  readonly text: string;
  readonly review: boolean;
}

export interface RungVerdict {
  readonly kind: string;
  readonly note: RungNote | null;
}

/** What apply() returns: the rung's verdict, or the error arm - the runner
 * fails the sync with its message (prefixed by the target's display name)
 * and later rungs do not run. The message must not quote
 * target-controlled content - it reaches the public log. */
export type RungOutcome =
  | { readonly kind: "verdict"; readonly verdict: RungVerdict }
  | { readonly kind: "error"; readonly message: string };

/** A rung file's default export. The file imports only `node:`/`bun:`
 * specifiers (the migrations-self-contained ssot rule), stages what it
 * changes, and never throws for a target state it can name. */
export interface Rung {
  /** Equals the filename without `.ts`. */
  readonly id: string;
  apply(target: RungTarget): RungOutcome;
}

/** One pending rung: its file, id, and the build commit it loads from. */
export interface PendingRung {
  readonly file: string;
  readonly id: string;
  readonly commit: string;
}

function git(platformDir: string, args: string[]): string {
  const proc = capture(["git", "-C", platformDir, ...args]);
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed in ${platformDir}: ${proc.stderr.trim()}`);
  }
  return proc.stdout;
}

/** The rung files under migrations/ at a build commit. Throws when the
 * commit does not resolve (an unreadable tree must never read as "no
 * rungs"), when the directory carries a path that is not a rung file, or
 * when two rung files share a number (the ladder's order would be
 * ambiguous). */
export function rungFiles(platformDir: string, commit: string): string[] {
  const listing = git(platformDir, ["ls-tree", "--name-only", commit, `${MIGRATIONS_DIR}/`]);
  const files = listing
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(`${MIGRATIONS_DIR}/`.length));
  const stray = files.find((file) => !RUNG_FILE_RE.test(file));
  if (stray !== undefined) {
    throw new Error(
      `the build commit ${commit.slice(0, 12)} carries ${MIGRATIONS_DIR}/${stray}, which is not a rung file (mNNNN_<slug>.ts)`,
    );
  }
  const byNumber = new Map<string, string>();
  for (const file of files) {
    const number = file.slice(1, 5);
    const other = byNumber.get(number);
    if (other !== undefined) {
      throw new Error(
        `the build commit ${commit.slice(0, 12)} carries two rungs numbered ${number} (${other}, ${file}); ladder order is ambiguous`,
      );
    }
    byNumber.set(number, file);
  }
  return files;
}

/** The first-parent build commits in (oldSha, newSha], oldest first. */
export function buildCommits(platformDir: string, oldSha: string, newSha: string): string[] {
  return git(platformDir, ["rev-list", "--first-parent", "--reverse", `${oldSha}..${newSha}`])
    .split("\n")
    .filter((line) => line !== "");
}

/** The walk over build history: rungs present in any commit of (old, new]
 * and absent from old's tree, each bound to the newest commit carrying it,
 * in filename order. No base (oldSha null) is the delivered tree alone
 * with nothing crossed. */
export function pendingRungs(
  platformDir: string,
  oldSha: string | null,
  newSha: string,
): PendingRung[] {
  const commits = oldSha === null ? [newSha] : buildCommits(platformDir, oldSha, newSha);
  const crossed = new Set(oldSha === null ? [] : rungFiles(platformDir, oldSha));
  const newest = new Map<string, string>();
  for (const commit of commits) {
    for (const file of rungFiles(platformDir, commit)) {
      if (!crossed.has(file)) newest.set(file, commit);
    }
  }
  return [...newest]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, commit]) => ({ file, id: file.slice(0, -".ts".length), commit }));
}

export interface FetchedRung extends PendingRung {
  /** Where the source from the build commit was written. */
  readonly path: string;
}

/** Every pending rung's source, read from its build commit and written
 * under `scratchDir/<commit>/` - all of them BEFORE any is loaded: bun
 * caches a directory's listing at the first module resolution in it, so a
 * file written into that directory afterwards would resolve as missing. */
export function fetchRungs(
  platformDir: string,
  pending: readonly PendingRung[],
  scratchDir: string,
): FetchedRung[] {
  return pending.map((entry) => {
    const source = git(platformDir, ["show", `${entry.commit}:${MIGRATIONS_DIR}/${entry.file}`]);
    const dir = join(scratchDir, entry.commit);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, entry.file);
    writeFileSync(path, source);
    return { ...entry, path };
  });
}

/** The fetched rung module. One without a `{ id, apply }` default export,
 * or whose id is not its filename, is a hard error, never a skip. */
export function loadRung(fetched: FetchedRung): Rung {
  const loaded = createRequire(import.meta.url)(fetched.path) as { default?: unknown };
  const rung = loaded.default as Partial<Rung> | undefined;
  if (
    typeof rung !== "object" ||
    rung === null ||
    typeof rung.apply !== "function" ||
    rung.id !== fetched.id
  ) {
    throw new Error(
      `${MIGRATIONS_DIR}/${fetched.file} at build ${fetched.commit.slice(0, 12)} does not default-export a rung { id: "${fetched.id}", apply }`,
    );
  }
  return rung as Rung;
}

function isNote(value: unknown): value is RungNote | null {
  if (value === null) return true;
  const note = value as Partial<RungNote> | undefined;
  return (
    typeof note === "object" && typeof note?.text === "string" && typeof note.review === "boolean"
  );
}

/** apply() with its result checked against the outcome contract: a throw
 * or a malformed value is the error arm, so a broken rung fails the sync
 * instead of being skipped. A thrown message is a rung bug's text and can
 * quote target paths, so a hidden target gets the value-free form; the
 * error arm's own message is value-free by the rung contract. */
export function applyRung(rung: Rung, target: RungTarget, hidden: boolean): RungOutcome {
  let outcome: unknown;
  try {
    outcome = rung.apply(target);
  } catch (err) {
    return {
      kind: "error",
      message: hidden
        ? "threw (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md."
        : `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const shaped = outcome as Partial<RungOutcome & { verdict: Partial<RungVerdict> }> | null;
  if (shaped?.kind === "error" && typeof shaped.message === "string") {
    return { kind: "error", message: shaped.message };
  }
  if (
    shaped?.kind === "verdict" &&
    typeof shaped.verdict === "object" &&
    shaped.verdict !== null &&
    typeof shaped.verdict.kind === "string" &&
    isNote(shaped.verdict.note)
  ) {
    return { kind: "verdict", verdict: { kind: shaped.verdict.kind, note: shaped.verdict.note } };
  }
  return { kind: "error", message: "returned a value that is neither a verdict nor the error arm" };
}

/** Every staged, unstaged, or untracked path in the target checkout. The
 * exit code is checked before the emptiness: a failed status prints
 * nothing, which a bare emptiness test would read as clean. */
function dirtyPaths(targetDir: string): string[] {
  return git(targetDir, ["status", "--porcelain"])
    .split("\n")
    .filter((line) => line !== "");
}

/** Every ignored file in the target checkout, one path per file (status
 * porcelain would collapse an ignored directory to one line and hide a
 * file added beneath it): plain porcelain omits them, so a rung that
 * dropped an ignored file would otherwise read as clean. */
export function ignoredPaths(targetDir: string): string[] {
  return git(targetDir, ["ls-files", "--others", "--ignored", "--exclude-standard"])
    .split("\n")
    .filter((line) => line !== "");
}

/** Commit what the rung staged as the sync identity; false when nothing
 * was staged (an idempotent rung that found the target crossed). */
export function commitStaged(targetDir: string, id: string): boolean {
  const staged = capture(["git", "-C", targetDir, "diff", "--cached", "--quiet"]);
  if (staged.exitCode === 0) return false;
  if (staged.exitCode !== 1) {
    throw new Error(`git diff --cached failed in ${targetDir}: ${staged.stderr.trim()}`);
  }
  git(targetDir, [...identityArgs(SYNC_IDENTITY), "commit", "-qm", `chore: run migration ${id}`]);
  return true;
}

export interface AppliedRung {
  id: string;
  kind: string;
  note: RungNote | null;
  committed: boolean;
}

export interface RunOutcome {
  /** Rungs that ran, in order, with their verdict kind and note. */
  applied: AppliedRung[];
  /** The first error arm, which stopped the ladder; null when every
   * pending rung reported a verdict. */
  error: { id: string; message: string } | null;
}

export interface RunOptions {
  /** The target is a hide-details repository: no rung bug's text may
   * reach the public log. */
  readonly hidden: boolean;
  /** The ignored paths present before the ladder ran; a rung may add
   * none (an ignored file is invisible to copier's dirty-tree check and
   * to the commit, so it would ride into nothing and hide a rung bug). */
  readonly ignoredBefore: ReadonlySet<string>;
}

/** Run `pending` in order against `target`, committing after each
 * verdict and stopping at the first error arm. A rung that left changes
 * it did not stage is an error too: copier refuses a dirty tree, and the
 * ladder must not hide which rung dirtied it. */
export function runRungs<P extends PendingRung>(
  target: RungTarget,
  pending: readonly P[],
  load: (rung: P) => Rung,
  options: RunOptions,
): RunOutcome {
  const applied: AppliedRung[] = [];
  for (const entry of pending) {
    const outcome = applyRung(load(entry), target, options.hidden);
    if (outcome.kind === "error") {
      return { applied, error: { id: entry.id, message: outcome.message } };
    }
    const committed = commitStaged(target.dir, entry.id);
    const leftovers = [
      ...dirtyPaths(target.dir),
      ...ignoredPaths(target.dir).filter((line) => !options.ignoredBefore.has(line)),
    ];
    if (leftovers.length > 0) {
      return {
        applied,
        error: {
          id: entry.id,
          message: `left ${leftovers.length} unstaged, untracked, or ignored path(s) behind; a rung stages everything it changes`,
        },
      };
    }
    applied.push({
      id: entry.id,
      kind: outcome.verdict.kind,
      note: outcome.verdict.note,
      committed,
    });
  }
  return { applied, error: null };
}

/** The two PR-body reports: notes that hold the PR and notes that do not,
 * each note a block separated by a blank line; "" when none. Always
 * written, so an absent file can never be mistaken for a run that never
 * happened. */
export function writeReports(runnerTemp: string, outcome: RunOutcome): void {
  const texts = (review: boolean) =>
    outcome.applied
      .filter((entry) => entry.note !== null && entry.note.review === review)
      .map((entry) => `${(entry.note as RungNote).text}\n`)
      .join("\n");
  writeFileSync(join(runnerTemp, MIGRATIONS_NAME), texts(false), "utf-8");
  writeFileSync(join(runnerTemp, MIGRATIONS_REVIEW_NAME), texts(true), "utf-8");
}

export interface LadderRun {
  platformDir: string;
  targetDir: string;
  /** The recorded build commit, or null when the target has no usable
   * base (recorded_commit.ts's judgment, made upstream). */
  oldSha: string | null;
  newSha: string;
  runnerTemp: string;
  hidden: boolean;
}

/** The whole leg: walk, run, report. Throws on a dirty checkout, an
 * unreadable build history, or a malformed rung file; an error ARM is
 * returned in the outcome (the reports for the rungs that did run are
 * written first). */
export function applyPending(run: LadderRun): RunOutcome {
  const dirty = dirtyPaths(run.targetDir);
  if (dirty.length > 0) {
    throw new Error(
      `the target checkout carries ${dirty.length} uncommitted path(s); the ladder runs on a clean tree so each rung's commit holds only its own changes`,
    );
  }
  // The delivered ref as a full sha: the rehearsal hands over a tag name,
  // and the scratch paths and the target's view both want the object id.
  const newSha = git(run.platformDir, ["rev-parse", "--verify", `${run.newSha}^{commit}`]).trim();
  const pending = fetchRungs(
    run.platformDir,
    pendingRungs(run.platformDir, run.oldSha, newSha),
    join(run.runnerTemp, MIGRATIONS_DIR),
  );
  const outcome = runRungs({ dir: run.targetDir, oldSha: run.oldSha, newSha }, pending, loadRung, {
    hidden: run.hidden,
    ignoredBefore: new Set(ignoredPaths(run.targetDir)),
  });
  writeReports(run.runnerTemp, outcome);
  return outcome;
}

function main(): number {
  const display = env("TARGET_DISPLAY", "target");
  const oldSha = env("OLD_SHA");
  if (oldSha === "") {
    console.log(
      `${display}: no usable base; every rung on the delivered tree runs, each idempotent`,
    );
  } else if (!FULL_SHA_RE.test(oldSha)) {
    // The resolver upstream hands over a full object id or ""; anything
    // else is a wiring mistake that git would resolve as a revspec.
    error(
      `${display}: OLD_SHA must be a full 40-hex commit sha or empty, got a value of another shape`,
    );
    return 1;
  }
  let outcome: RunOutcome;
  try {
    outcome = applyPending({
      platformDir: env("PLATFORM_DIR", "."),
      targetDir: env("TARGET_DIR", "target"),
      oldSha: oldSha === "" ? null : oldSha,
      newSha: requireEnv("TARGET_REF"),
      runnerTemp: requireEnv("RUNNER_TEMP"),
      hidden: hideDetails(),
    });
  } catch (err) {
    error(`${display}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (const entry of outcome.applied) {
    const line = `${display}: migration ${entry.id} -> ${entry.kind}${entry.committed ? " (committed)" : ""}`;
    if (entry.note === null) console.log(line);
    else notice(`${line} (the PR body carries the note)`);
  }
  if (outcome.error !== null) {
    error(`${display}: migration ${outcome.error.id}: ${outcome.error.message}`);
    return 1;
  }
  if (outcome.applied.length === 0) console.log(`${display}: no pending migrations`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
