#!/usr/bin/env bun
// Runs from the caller's checkout; the exit code colours the step only, the gate reads report.ts. The clone of
// repo-platform at the recorded commit, under the scratch root, judges the tree with its own check.ts.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { error, notice, setFailed, summary, warning } from "@actions/core";
import {
  capture,
  env,
  failureDetail,
  messageOf,
  type RunResult,
  requireEnv,
  run,
  succeeded,
} from "../../shared/action_runtime.ts";
import { DELIVERY_REF, PLATFORM_NAME, SYNC_LABEL } from "../../shared/platform.ts";
import { classify, type Integrity, writeVerdict } from "./verdict.ts";

const STEP_TIMEOUT_MS = 300_000;
const CHECK = "actions/validate-managed-files/check.ts";

/** The paths action.yml hands the step, and the checkout it runs in. */
interface Paths {
  verdictFile: string;
  scratch: string;
  bun: string;
  actionPath: string;
  platform: string;
  root: string;
}

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
async function reportFreshness(platform: string, commit: string, short: string): Promise<void> {
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
        "A sync moves this repository's judge once it writes a change or the checker differs. Nothing here fails for that.";
      notice(line);
    } else if (ancestor.exit.kind === "exited" && ancestor.exit.code === 1) {
      line = `The synced commit (${short}) is not on ${DELIVERY_REF}'s history. A sync re-stamps it once it writes a change or the checker differs.`;
      warning(line);
    } else {
      line = `Freshness is unknown: git could not answer (${failureDetail(count ?? ancestor)}).`;
      warning(line);
    }
  }
  await summary.addRaw(`${line}\n\n`).write();
}

async function judgeAtRecordedCommit(paths: Paths, commit: string): Promise<Integrity> {
  const short = commit.slice(0, 12);
  const outcome = env("PLATFORM_OUTCOME");
  if (outcome !== "success") {
    return notJudged(
      `${PLATFORM_NAME} could not be cloned at ${short} (clone step outcome: ${outcome || "none"}); ` +
        "the recorded commit must be one it holds",
    );
  }
  const visibility = requireEnv("REPOSITORY_PRIVATE");
  if (visibility !== "true" && visibility !== "false") {
    return notJudged(`the private input must be true or false, not "${visibility}"`);
  }
  const installed = run([paths.bun, "install", "--frozen-lockfile", "--silent"], {
    cwd: paths.platform,
    timeoutMs: STEP_TIMEOUT_MS,
  });
  if (!succeeded(installed)) {
    return notJudged(`installing ${PLATFORM_NAME}'s dependencies at ${short} failed`);
  }
  const checked = capture(
    [
      paths.bun,
      join(paths.platform, CHECK),
      "--target",
      paths.root,
      "--repository",
      requireEnv("REPOSITORY"),
      "--private",
      visibility,
      "--build",
      commit,
    ],
    { cwd: paths.root, timeoutMs: STEP_TIMEOUT_MS },
  );
  await reportFreshness(paths.platform, commit, short);
  return judgeCheck(checked, short);
}

function hygiene(paths: Paths): Integrity {
  const findingsFile = join(paths.scratch, "findings.md");
  const exit = run(
    [paths.bun, join(paths.actionPath, "validator", "validate_managed_files.ts"), paths.root],
    { cwd: paths.root, env: { FINDINGS_FILE: findingsFile }, timeoutMs: STEP_TIMEOUT_MS },
  );
  return classify(exit, STEP_TIMEOUT_MS, findingsFile);
}

function merge(a: Integrity, b: Integrity): Integrity {
  if (a.kind === "not-judged" || b.kind === "clean") return a;
  if (b.kind === "not-judged" || a.kind === "clean") return b;
  return { kind: "findings", findings: `${a.findings}\n\n${b.findings}` };
}

async function main(): Promise<number> {
  const paths: Paths = {
    verdictFile: requireEnv("VERDICT_FILE"),
    scratch: requireEnv("SCRATCH_DIR"),
    bun: requireEnv("ACTION_BUN"),
    actionPath: requireEnv("ACTION_PATH"),
    platform: requireEnv("PLATFORM_DIR"),
    root: resolve("."),
  };
  mkdirSync(paths.scratch, { recursive: true });
  const commit = env("COMMIT");
  const judged =
    commit === ""
      ? notJudged(requireEnv("COMMIT_PROBLEM"))
      : await judgeAtRecordedCommit(paths, commit);
  const verdict = merge(judged, hygiene(paths));
  writeVerdict(paths.verdictFile, verdict);
  // The writer's output is captured into the verdict, never printed, so this is the log's one line for the whole.
  if (verdict.kind === "not-judged") error(verdict.reason);
  else if (verdict.kind === "clean") console.log("Verdict: clean.");
  else console.log("Verdict: findings; the report step carries them to the step summary.");
  return verdict.kind === "clean" ? 0 : 1;
}

try {
  process.exit(await main());
} catch (cause) {
  setFailed(messageOf(cause));
}
