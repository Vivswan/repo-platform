#!/usr/bin/env bun
// Runs from the caller's checkout; the exit code colours the step only, the gate reads report.ts. The checkout of
// repo-platform at the recorded commit judges the tree with its own check.ts and is removed before the hygiene checks
// walk the checkout, so none of repo-platform's files is read as the repository's.

import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  capture,
  env,
  error,
  failureDetail,
  notice,
  type RunResult,
  requireEnv,
  run,
  succeeded,
  warning,
} from "../../shared/action_runtime.ts";
import { DELIVERY_REF, PLATFORM_NAME, SYNC_LABEL } from "../../shared/platform.ts";
import { classify, type Integrity, writeVerdict } from "./verdict.ts";

const STEP_TIMEOUT_MS = 300_000;
const CHECK = "actions/validate-managed-files/check.ts";

const verdictFile = requireEnv("VERDICT_FILE");
const scratch = requireEnv("SCRATCH_DIR");
const bun = requireEnv("ACTION_BUN");
const actionPath = requireEnv("ACTION_PATH");
const platform = requireEnv("PLATFORM_DIR");
const root = resolve(".");

const notJudged = (reason: string): Integrity => ({ kind: "not-judged", reason });

/** What check.ts printed, fenced as a diff (its lines are finding lines and unified diffs), with the remedy. The
 *  writer's refusal (exit 2) carries its own remedy. */
function checkFindings(short: string, exitCode: number, output: string): string {
  const remedy =
    exitCode === 2
      ? ""
      : `\n\nEach path named differs from what ${PLATFORM_NAME} writes at the commit this repository was synced ` +
        "with (the + lines are the sync's). Restore it from git history, or run the sync: on a pull request, the " +
        `\`${SYNC_LABEL}\` label syncs its branch and brings a registration change's files with it.`;
  return `#### ${PLATFORM_NAME} at ${short}\n\n\`\`\`diff\n${output}\n\`\`\`${remedy}`;
}

function judgeCheck(result: RunResult, short: string): Integrity {
  if (result.stderr !== "") console.error(result.stderr);
  const output = result.stdout.replace(/\n+$/, "");
  const exit = result.exit;
  if (exit.kind === "exited" && exit.code === 0) return { kind: "clean" };
  if (exit.kind === "exited" && (exit.code === 1 || exit.code === 2) && output !== "") {
    return { kind: "findings", findings: checkFindings(short, exit.code, output) };
  }
  return notJudged(
    `${PLATFORM_NAME}'s check at ${short} ended without a verdict (${failureDetail(result)})`,
  );
}

/** Information only: the exit code never follows it. */
function reportFreshness(commit: string, short: string): void {
  const git = (args: string[]) =>
    capture(["git", ...args], { cwd: platform, timeoutMs: STEP_TIMEOUT_MS });
  const tag = git(["rev-parse", "--verify", "--quiet", `refs/tags/${DELIVERY_REF}^{commit}`]);
  let line: string;
  if (!succeeded(tag.exit)) {
    line = `The ${DELIVERY_REF} tag was not fetched, so freshness is unknown.`;
    warning(line);
  } else if (tag.stdout.trim() === commit) {
    line = `Up to date with ${DELIVERY_REF} (${short}).`;
    notice(line);
  } else {
    const tip = tag.stdout.trim();
    const ancestor = git(["merge-base", "--is-ancestor", commit, tip]);
    const count = succeeded(ancestor.exit)
      ? git(["rev-list", "--count", `${commit}..${tip}`])
      : null;
    if (count !== null && succeeded(count.exit)) {
      line =
        `${DELIVERY_REF} moved ${count.stdout.trim()} commits past the synced commit (${short} -> ${tip.slice(0, 12)}). ` +
        "The next sync moves this repository's judge. Nothing here fails for that.";
      notice(line);
    } else if (ancestor.exit.kind === "exited" && ancestor.exit.code === 1) {
      line = `The synced commit (${short}) is not on ${DELIVERY_REF}'s history. A sync re-stamps it once the delivered surface differs.`;
      warning(line);
    } else {
      line = `Freshness is unknown: git could not answer (${failureDetail(count ?? ancestor)}).`;
      warning(line);
    }
  }
  appendFileSync(requireEnv("GITHUB_STEP_SUMMARY"), `${line}\n\n`);
}

function judgeAtRecordedCommit(commit: string): Integrity {
  const short = commit.slice(0, 12);
  const outcome = env("PLATFORM_OUTCOME");
  if (outcome !== "success") {
    return notJudged(
      `${PLATFORM_NAME} could not be checked out at ${short} (checkout step outcome: ${outcome || "none"}); ` +
        "the recorded commit must be one it holds",
    );
  }
  const visibility = requireEnv("REPOSITORY_PRIVATE");
  if (visibility !== "true" && visibility !== "false") {
    return notJudged(`the private input must be true or false, not "${visibility}"`);
  }
  const installed = run([bun, "install", "--frozen-lockfile", "--silent"], {
    cwd: platform,
    timeoutMs: STEP_TIMEOUT_MS,
  });
  if (!succeeded(installed)) {
    return notJudged(`installing ${PLATFORM_NAME}'s dependencies at ${short} failed`);
  }
  const checked = capture(
    [
      bun,
      join(platform, CHECK),
      "--target",
      root,
      "--repository",
      requireEnv("REPOSITORY"),
      "--private",
      visibility,
      "--build",
      commit,
    ],
    { cwd: root, timeoutMs: STEP_TIMEOUT_MS },
  );
  reportFreshness(commit, short);
  return judgeCheck(checked, short);
}

function hygiene(): Integrity {
  const findingsFile = join(scratch, "findings.md");
  const exit = run([bun, join(actionPath, "validator", "validate_managed_files.ts"), root], {
    cwd: root,
    env: { FINDINGS_FILE: findingsFile },
    timeoutMs: STEP_TIMEOUT_MS,
  });
  return classify(exit, STEP_TIMEOUT_MS, findingsFile);
}

function merge(a: Integrity, b: Integrity): Integrity {
  if (a.kind === "not-judged" || b.kind === "clean") return a;
  if (b.kind === "not-judged" || a.kind === "clean") return b;
  return { kind: "findings", findings: `${a.findings}\n\n${b.findings}` };
}

mkdirSync(scratch, { recursive: true });
const commit = env("COMMIT");
let judged: Integrity;
if (commit === "") {
  // The checkout was skipped, so whatever stands at the platform path is the repository's own and stays.
  judged = notJudged(requireEnv("COMMIT_PROBLEM"));
} else {
  try {
    judged = judgeAtRecordedCommit(commit);
  } finally {
    rmSync(platform, { recursive: true, force: true });
  }
}
const verdict = merge(judged, hygiene());
writeVerdict(verdictFile, verdict);
if (verdict.kind === "not-judged") error(verdict.reason);
process.exit(verdict.kind === "clean" ? 0 : 1);
