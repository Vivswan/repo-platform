// Dependabot bumps the target package but leaves stale nested entries behind, and bun keeps a stale lockfile
// as a valid resolution, so only a delete-then-resolve drops them.

import { appendFileSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ChildExit,
  capture,
  error,
  failureDetail,
  requireEnv,
  run,
  succeeded,
  warning,
} from "../shared/action_runtime.ts";

/** Git pathspecs for every tracked lockfile: '*' crosses '/'. */
const LOCKFILE_PATHSPECS = ["bun.lock", "*/bun.lock"];
const GIT_DEADLINE_MS = 120_000;
/** A from-scratch resolve of a large workspace; the job allows 15 minutes. */
const INSTALL_DEADLINE_MS = 600_000;
const PUSH_DEADLINE_MS = 300_000;

const COMMIT_SUBJECT = "build(deps): dedupe bun lockfile";
/** Keeps Dependabot rebasing and updating the PR over this commit. */
const COMMIT_TRAILER = "[dependabot skip]";
/** The caller's sticky PR comment says the same: files/bun/.github/workflows/dependabot-bun-lockfile.yml. */
const PUSHED_WARNING =
  "lockfile fix pushed with github.token, which starts no workflows: the new head's pull_request run waits for approval. " +
  "Open it in the Actions tab and choose Approve and run, or push an empty commit.";

function exitCodeOf(exit: ChildExit): number {
  return exit.kind === "exited" ? exit.code : 1;
}

function exitReason(exit: ChildExit): string {
  return failureDetail({ exit, stdout: "", stderr: "" });
}

/** Only the verb is named, never the argv: the push argv carries the token. */
function must(command: string[], timeoutMs: number): void {
  const exit = run(command, { timeoutMs });
  if (succeeded(exit)) return;
  error(`${command[0]} ${command[1]} failed: ${exitReason(exit)}`);
  process.exit(exitCodeOf(exit));
}

function trackedLockfiles(): string[] {
  const result = capture(["git", "ls-files", "-z", "--", ...LOCKFILE_PATHSPECS], {
    timeoutMs: GIT_DEADLINE_MS,
  });
  if (!succeeded(result.exit)) {
    error(`git ls-files failed: ${failureDetail(result)}`);
    process.exit(exitCodeOf(result.exit));
  }
  return result.stdout.split("\0").filter((path) => path !== "");
}

/** --lockfile-only runs no lifecycle scripts next to the write credential.
 *  bun deletes an empty lockfile outright, so the committed one is restored. */
function regenerate(lockfiles: string[]): void {
  for (const lock of lockfiles) {
    rmSync(lock);
    must(
      ["bun", "install", "--lockfile-only", "--ignore-scripts", "--cwd", dirname(lock)],
      INSTALL_DEADLINE_MS,
    );
    if (!existsSync(lock)) must(["git", "checkout", "--", lock], GIT_DEADLINE_MS);
  }
}

/** git diff --quiet: 0 means clean, 1 means changed, anything else is git failing. */
function lockfilesChanged(): boolean {
  const exit = run(["git", "diff", "--quiet", "--", ...LOCKFILE_PATHSPECS], {
    timeoutMs: GIT_DEADLINE_MS,
  });
  if (exit.kind === "exited" && exit.code === 0) return false;
  if (exit.kind === "exited" && exit.code === 1) return true;
  error(`git diff failed: ${exitReason(exit)}`);
  process.exit(exitCodeOf(exit));
}

function commitAndPush(
  lockfiles: string[],
  repository: string,
  headRef: string,
  token: string,
): void {
  must(["git", "config", "user.name", "github-actions[bot]"], GIT_DEADLINE_MS);
  must(
    ["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"],
    GIT_DEADLINE_MS,
  );
  must(["git", "add", "--", ...lockfiles], GIT_DEADLINE_MS);
  must(["git", "commit", "-m", COMMIT_SUBJECT, "-m", COMMIT_TRAILER], GIT_DEADLINE_MS);
  must(
    [
      "git",
      "push",
      `https://x-access-token:${token}@github.com/${repository}.git`,
      `HEAD:${headRef}`,
    ],
    PUSH_DEADLINE_MS,
  );
}

function main(): void {
  const token = requireEnv("TOKEN");
  const headRef = requireEnv("HEAD_REF");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const lockfiles = trackedLockfiles();
  regenerate(lockfiles);
  if (!lockfilesChanged()) {
    console.log("lockfiles already deduped");
    return;
  }
  commitAndPush(lockfiles, repository, headRef, token);
  appendFileSync(requireEnv("GITHUB_OUTPUT"), "pushed=true\n");
  warning(PUSHED_WARNING);
}

main();
