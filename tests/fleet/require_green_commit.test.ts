import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { calledRefusal, waitForGreen } from "../../.github/scripts/fleet/require_green_commit";
import type { GhRunner } from "../../.github/scripts/shared/all_green.ts";
import type { RunResult } from "../../.github/scripts/shared/proc.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const ROOT = join(import.meta.dir, "../..");
const SHA = "000000000000000000000000000000000000000a";
const OTHER = "cccccccccccccccccccccccccccccccccccccccc";
/** The env name settings-repos.yml passes the call input under; the script reads it by this literal. */
const SOURCE_SHA = "SOURCE_SHA";
const dirs = tempDirs();

type Check = { status?: string; conclusion?: string | null };

function checkRuns(checks: Check[]): RunResult {
  return {
    timedOut: false,
    pid: 0,
    exitCode: 0,
    stdout: JSON.stringify({
      check_runs: checks.map((check) => ({
        name: "all-green",
        status: check.status ?? "completed",
        conclusion: check.conclusion === undefined ? "success" : check.conclusion,
        app: { slug: "github-actions" },
      })),
    }),
    stderr: "",
  };
}
const GREEN = checkRuns([{}]);
const RED = checkRuns([{ conclusion: "failure" }]);
const PENDING = checkRuns([{ status: "in_progress", conclusion: null }]);
const NONE = checkRuns([]);
const FAILED_READ: RunResult = { timedOut: false, pid: 0, exitCode: 1, stdout: "", stderr: "boom" };

function ghReplaying(answers: RunResult[]): { gh: GhRunner; calls: () => number } {
  let call = 0;
  const gh: GhRunner = () => answers[Math.min(call++, answers.length - 1)];
  return { gh, calls: () => call };
}

describe("waitForGreen", () => {
  // Every row bounds the wait. The sleep is stubbed and the clock is real, so a final verdict the loop kept polling
  // would spin until the runner's own timeout; the bound turns that into a red call count within a second.
  test.each<{
    reason: string;
    answers: RunResult[];
    deadlineMs: number;
    result: unknown;
    calls: number;
    sleeps: number[];
  }>([
    {
      reason: "an already-green commit passes without waiting",
      answers: [GREEN],
      deadlineMs: 1_000,
      result: null,
      calls: 1,
      sleeps: [],
    },
    {
      reason: "a red conclusion fails at once: waiting cannot turn it green",
      answers: [RED],
      deadlineMs: 1_000,
      result: expect.stringMatching(/concluded 'failure'$/),
      calls: 1,
      sleeps: [],
    },
    {
      // A dispatched settings run can race the tip's CI run, so the first probes land before a completed verdict.
      reason: "an in-progress verdict is waited out to a green one",
      answers: [PENDING, PENDING, GREEN],
      deadlineMs: 1_000,
      result: null,
      calls: 3,
      sleeps: [5, 5],
    },
    {
      reason: "a missing verdict is retried, then green: CI and its verdict land after the push",
      answers: [NONE, GREEN],
      deadlineMs: 1_000,
      result: null,
      calls: 2,
      sleeps: [5],
    },
    {
      reason: "no verdict by the deadline fails CLOSED, naming the wait",
      answers: [PENDING],
      deadlineMs: 0,
      result: expect.stringMatching(/verdict is still 'in_progress'.*wait for a verdict is over/),
      calls: 1,
      sleeps: [],
    },
    {
      reason: "an API failure gets the deadline, then still fails closed",
      answers: [FAILED_READ],
      deadlineMs: 0,
      result: expect.stringMatching(/check runs failed.*wait for a verdict is over/),
      calls: 1,
      sleeps: [],
    },
  ])("$reason", ({ answers, deadlineMs, result, calls, sleeps }) => {
    const gh = ghReplaying(answers);
    const slept: number[] = [];
    const outcome = waitForGreen("o/r", SHA, {
      gh: gh.gh,
      deadlineMs,
      pollMs: 5,
      sleep: (ms) => slept.push(ms),
      log: () => {},
    });
    const got: { result: unknown; calls: number; sleeps: number[] } = {
      result: outcome,
      calls: gh.calls(),
      sleeps: slept,
    };
    expect(got).toEqual({ result, calls, sleeps });
  });
});

describe("calledRefusal", () => {
  // Past the bound the poll fails CLOSED on every non-green shape. A red conclusion waits the bound out too (the
  // predicate polls for a fresh success because a re-judged sha's verdict can trail a stale one), so the refusal names
  // the conclusion at the bound, not on the first read.
  test.each<{ reason: string; answer: RunResult; refusal: unknown }>([
    { reason: "the run's own green commit passes on ONE probe", answer: GREEN, refusal: null },
    {
      reason: "a red verdict refuses at the bound",
      answer: RED,
      refusal: expect.stringContaining("is not green - its all-green verdict concluded 'failure'"),
    },
    {
      reason: "a verdict still in progress past the bound refuses",
      answer: PENDING,
      refusal: expect.stringContaining(
        "is not green - its all-green verdict is still 'in_progress' after 0s",
      ),
    },
    {
      reason: "no verdict at all past the bound refuses (the call arrived from somewhere else)",
      answer: NONE,
      refusal: expect.stringContaining(
        "is not green - no all-green verdict check exists there (waited 0s)",
      ),
    },
  ])("$reason, no sleep", ({ answer, refusal }) => {
    const gh = ghReplaying([answer]);
    const sleeps: number[] = [];
    const outcome = calledRefusal("o/r", SHA, SHA, {
      gh: gh.gh,
      wait: { deadlineMs: 0, sleepMs: 5, sleep: (ms) => sleeps.push(ms) },
    });
    const got: { refusal: unknown; calls: number; sleeps: number[] } = {
      refusal: outcome,
      calls: gh.calls(),
      sleeps,
    };
    expect(got).toEqual({ refusal, calls: 1, sleeps: [] });
  });

  // The trust boundary: a called run applies the judged commit of the CI run that called it. Without the equality any
  // green sha would vouch for THIS checkout's layer files.
  test.each([
    {
      reason: "a sha input that is not this run's commit",
      sourceSha: OTHER,
      refusal: `the sha input ${OTHER.slice(0, 12)} is not this run's own commit ${SHA.slice(0, 12)}`,
    },
    {
      reason: "a truncated sha input",
      sourceSha: SHA.slice(0, 12),
      refusal: `${SOURCE_SHA} is not a full commit sha (got '${SHA.slice(0, 12)}')`,
    },
  ])("$reason is refused before any probe", ({ sourceSha, refusal }) => {
    const gh = ghReplaying([GREEN]);
    expect(calledRefusal("o/r", SHA, sourceSha, { gh: gh.gh })).toContain(refusal);
    expect(gh.calls()).toBe(0);
  });
});

describe("the CLI", () => {
  const script = join(ROOT, ".github/scripts/fleet/require_green_commit.ts");
  const bin = dirs.dir("require-green-cli-bin-");
  // Every call is logged: "refused before any probe" is the log's absence, never a wait for the real gh to fail.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\necho "gh $*" >> "$STUB_CALLS"\nprintf '%s' "$FAKE_CHECK_RUNS"\n`,
    { mode: 0o755 },
  );

  /** A main run judging a green tip unless `overrides` says otherwise; an undefined value unsets the variable. */
  function runCli(overrides: Record<string, string | undefined>) {
    const work = dirs.dir("require-green-cli-run-");
    const calls = join(work, "gh-calls");
    const output = join(work, "github-output");
    const env: Record<string, string | undefined> = {
      ...process.env,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SHA: SHA,
      GITHUB_REF: "refs/heads/main",
      GITHUB_OUTPUT: output,
      GREEN_WAIT_MS: "0",
      // Unset in the base env: an ambient value from the shell would take every row down the called path.
      [SOURCE_SHA]: undefined,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_CALLS: calls,
      FAKE_CHECK_RUNS: GREEN.stdout,
      ...overrides,
    };
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
    const proc = boundedSpawnSync(["bun", script], { env });
    return {
      ...proc,
      lines: proc.stdout.trimEnd().split("\n"),
      ghCalls: existsSync(calls) ? readFileSync(calls, "utf-8").trimEnd().split("\n").length : 0,
      output: existsSync(output),
    };
  }

  // A workflow_dispatch can aim at any branch, so this is the one guard between an unmerged branch's layer files and
  // the fleet; an unset ref (never the case on a real runner) refuses rather than skips it.
  test.each([
    {
      reason: "a non-main ref",
      env: { GITHUB_REF: "refs/heads/feature" },
      message: "refusing the settings apply from refs/heads/feature",
    },
    {
      reason: "an unset GITHUB_REF, never treated as main,",
      env: { GITHUB_REF: undefined },
      message: "GITHUB_REF must be set",
    },
  ])("$reason is refused before any probe", ({ env, message }) => {
    const proc = runCli(env);
    const got = {
      refused: proc.exitCode !== 0,
      stdout: proc.stdout,
      stderr: proc.stderr,
      ghCalls: proc.ghCalls,
      output: proc.output,
    };
    expect(got).toEqual({
      refused: true,
      stdout: expect.stringContaining(message),
      stderr: "",
      ghCalls: 0,
      output: false,
    });
  });

  test.each<{
    reason: string;
    env: Record<string, string>;
    exitCode: number;
    line: unknown;
    ghCalls: number;
  }>([
    {
      reason: "a red tip exits 1 with the halt as an error annotation",
      env: { FAKE_CHECK_RUNS: RED.stdout },
      exitCode: 1,
      line: expect.stringMatching(
        /^::error::refusing the settings apply: commit 000000000000 is not green - its all-green verdict concluded 'failure'\./,
      ),
      ghCalls: 1,
    },
    {
      reason: "a green tip exits 0 and lets the apply proceed",
      env: {},
      exitCode: 0,
      line: "commit 000000000000 is green; the settings apply may proceed",
      ghCalls: 1,
    },
    {
      reason:
        "a sha input that is not this run's commit takes the called path and exits 1 before any probe",
      env: { [SOURCE_SHA]: OTHER },
      exitCode: 1,
      line: expect.stringMatching(
        new RegExp(
          `^::error::refusing the called settings apply: the sha input ${OTHER.slice(0, 12)} is not this run's own commit ${SHA.slice(0, 12)}\\.`,
        ),
      ),
      ghCalls: 0,
    },
  ])("$reason, publishing no output", ({ env, exitCode, line, ghCalls }) => {
    const proc = runCli(env);
    const got: {
      exitCode: number;
      lines: unknown[];
      stderr: string;
      ghCalls: number;
      output: boolean;
    } = {
      exitCode: proc.exitCode,
      lines: proc.lines,
      stderr: proc.stderr,
      ghCalls: proc.ghCalls,
      output: proc.output,
    };
    expect(got).toEqual({ exitCode, lines: [line], stderr: "", ghCalls, output: false });
  });

  test("settings-repos.yml hands the gate step the call's sha under the name the script reads", () => {
    const workflow = parseYaml(
      readFileSync(join(ROOT, ".github/workflows/settings-repos.yml"), "utf-8"),
    ) as { jobs: { plan: { steps: { run?: string; env?: Record<string, string> }[] } } };
    const gate = workflow.jobs.plan.steps.find((step) =>
      (step.run ?? "").includes("fleet/require_green_commit.ts"),
    );
    expect(gate?.env?.[SOURCE_SHA]).toBe("${{ inputs.sha }}");
  });
});
