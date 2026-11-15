import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { calledRefusal, waitForGreen } from "../../.github/scripts/fleet/require_green_commit";
import type { GitHubClient } from "../../actions/github-client/github.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import {
  clientOver,
  type FakeGithubServer,
  type FakeReply,
  spawnFakeGithub,
} from "../shared/fake_github";
import { tempDirs } from "../shared/temp_dir";

const ROOT = join(import.meta.dir, "../..");
const SHA = "000000000000000000000000000000000000000a";
const OTHER = "cccccccccccccccccccccccccccccccccccccccc";
const SOURCE_SHA = "SOURCE_SHA";
const dirs = tempDirs();

type Check = { status?: string; conclusion?: string | null };

function checkRuns(checks: Check[]): FakeReply {
  return {
    status: 200,
    body: {
      check_runs: checks.map((check) => ({
        name: "all-green",
        status: check.status ?? "completed",
        conclusion: check.conclusion === undefined ? "success" : check.conclusion,
        app: { slug: "github-actions" },
      })),
    },
  };
}
const GREEN = checkRuns([{}]);
const RED = checkRuns([{ conclusion: "failure" }]);
const PENDING = checkRuns([{ status: "in_progress", conclusion: null }]);
const NONE = checkRuns([]);
const FAILED_READ: FakeReply = { status: 403 };
const CHECK_RUNS = `repos/o/r/commits/${SHA}/check-runs`;

/** The client over the check-runs replies, in order, and how many reads it has made. */
function replaying(answers: FakeReply[]): { github: GitHubClient; calls: () => number } {
  const { client, github } = clientOver({ [CHECK_RUNS]: answers });
  return { github: client, calls: () => github.calls().length };
}

describe("waitForGreen", () => {
  // Every row bounds the wait. The sleep is stubbed and the clock is real, so a final verdict the loop kept polling
  // would spin until the runner's own timeout; the bound turns that into a red call count within a second.
  test.each<{
    reason: string;
    answers: FakeReply[];
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
  ])("$reason", async ({ answers, deadlineMs, result, calls, sleeps }) => {
    const gh = replaying(answers);
    const slept: number[] = [];
    const outcome = await waitForGreen("o/r", SHA, {
      github: gh.github,
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
  test.each<{
    reason: string;
    answers: FakeReply[];
    deadlineMs: number;
    refusal: unknown;
    calls: number;
    sleeps: number[];
  }>([
    {
      reason: "the run's own green commit passes on ONE probe, no sleep",
      answers: [GREEN],
      deadlineMs: 0,
      refusal: null,
      calls: 1,
      sleeps: [],
    },
    {
      // The Checks API can report the gate job's just-completed check as in progress for a moment after that job
      // released this leg: the read polls through it instead of refusing a green commit.
      reason: "a check in progress on the first read and green on the second passes",
      answers: [PENDING, GREEN],
      deadlineMs: 1_000,
      refusal: null,
      calls: 2,
      sleeps: [5],
    },
    {
      reason: "a red verdict refuses at the bound",
      answers: [RED],
      deadlineMs: 0,
      calls: 1,
      sleeps: [],
      refusal: expect.stringContaining("is not green - its all-green verdict concluded 'failure'"),
    },
    {
      reason: "a verdict still in progress past the bound refuses",
      answers: [PENDING],
      deadlineMs: 0,
      calls: 1,
      sleeps: [],
      refusal: expect.stringContaining(
        "is not green - its all-green verdict is still 'in_progress' after 0s",
      ),
    },
    {
      reason: "no verdict at all past the bound refuses (the call arrived from somewhere else)",
      answers: [NONE],
      deadlineMs: 0,
      calls: 1,
      sleeps: [],
      refusal: expect.stringContaining(
        "is not green - no all-green verdict check exists there (waited 0s)",
      ),
    },
  ])("$reason", async ({ answers, deadlineMs, refusal, calls, sleeps }) => {
    const gh = replaying(answers);
    const slept: number[] = [];
    const outcome = await calledRefusal("o/r", SHA, SHA, {
      github: gh.github,
      wait: { deadlineMs, sleepMs: 5, sleep: (ms) => slept.push(ms) },
    });
    const got: { refusal: unknown; calls: number; sleeps: number[] } = {
      refusal: outcome,
      calls: gh.calls(),
      sleeps: slept,
    };
    expect(got).toEqual({ refusal, calls, sleeps });
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
  ])("$reason is refused before any probe", async ({ sourceSha, refusal }) => {
    const gh = replaying([GREEN]);
    expect(await calledRefusal("o/r", SHA, sourceSha, { github: gh.github })).toContain(refusal);
    expect(gh.calls()).toBe(0);
  });
});

describe("the CLI", () => {
  const script = join(ROOT, ".github/scripts/fleet/require_green_commit.ts");
  // Every read is logged per run: "refused before any probe" is an empty log, never a wait for a real API to fail.
  let green: FakeGithubServer;
  let red: FakeGithubServer;
  let runs = 0;
  beforeAll(async () => {
    const logs = dirs.dir("require-green-cli-api-");
    green = await spawnFakeGithub({ [CHECK_RUNS]: [GREEN] }, join(logs, "green.log"));
    red = await spawnFakeGithub({ [CHECK_RUNS]: [RED] }, join(logs, "red.log"));
  });
  afterAll(() => {
    green.stop();
    red.stop();
  });

  function runCli(overrides: Record<string, string | undefined>, api = green) {
    const work = dirs.dir("require-green-cli-run-");
    const name = `run-${++runs}`;
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
      GH_TOKEN: "stub-token",
      GITHUB_API_URL: `${api.host}/${name}`,
      GITHUB_RETRY_BASE_MS: "0",
      ...overrides,
    };
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete env[name];
    }
    const proc = boundedSpawnSync(["bun", script], { env });
    return {
      ...proc,
      lines: proc.stdout.trimEnd().split("\n"),
      reads: api.calls(name).length,
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
      reads: proc.reads,
      output: proc.output,
    };
    expect(got).toEqual({
      refused: true,
      stdout: expect.stringContaining(message),
      stderr: "",
      reads: 0,
      output: false,
    });
  });

  test.each<{
    reason: string;
    env: Record<string, string>;
    red?: boolean;
    exitCode: number;
    line: unknown;
    reads: number;
  }>([
    {
      reason: "a red tip exits 1 with the halt as an error annotation",
      env: {},
      red: true,
      exitCode: 1,
      line: expect.stringMatching(
        /^::error::refusing the settings apply: commit 000000000000 is not green - its all-green verdict concluded 'failure'\./,
      ),
      reads: 1,
    },
    {
      reason: "a green tip exits 0 and lets the apply proceed",
      env: {},
      exitCode: 0,
      line: "commit 000000000000 is green; the settings apply may proceed",
      reads: 1,
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
      reads: 0,
    },
  ])("$reason, publishing no output", ({ env, red: isRed, exitCode, line, reads }) => {
    const proc = runCli(env, isRed === true ? red : green);
    const got: {
      exitCode: number;
      lines: unknown[];
      stderr: string;
      reads: number;
      output: boolean;
    } = {
      exitCode: proc.exitCode,
      lines: proc.lines,
      stderr: proc.stderr,
      reads: proc.reads,
      output: proc.output,
    };
    expect(got).toEqual({ exitCode, lines: [line], stderr: "", reads, output: false });
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
