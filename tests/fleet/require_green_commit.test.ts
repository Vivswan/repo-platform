// The settings apply's green gate: the bounded wait for the tip's verdict,
// the fail-closed halt on a red tip (every trigger alike), and the CALLED
// run's own-commit check. The gh probe and the sleep are injected; the CLI
// cases run the real script over a gh stub on PATH.

import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  calledRefusal,
  tipRefusal,
  waitForGreen,
} from "../../.github/scripts/fleet/require_green_commit";
import type { GhRunner } from "../../.github/scripts/shared/all_green.ts";
import { type BoundedSpawnResult, boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const SHA = "000000000000000000000000000000000000000a";
const dirs = tempDirs();
/** The RunResult fields a stubbed gh never exercises: no child ran. */
const NOT_SPAWNED = { timedOut: false, pid: 0 };

function ghAnswering(...pages: { status?: string; conclusion?: string | null }[][]): {
  gh: GhRunner;
  calls: () => number;
} {
  let call = 0;
  const gh: GhRunner = () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call++;
    return {
      ...NOT_SPAWNED,
      exitCode: 0,
      stdout: JSON.stringify({
        check_runs: page.map((check) => ({
          name: "all-green",
          status: check.status ?? "completed",
          conclusion: check.conclusion === undefined ? "success" : check.conclusion,
          external_id: "push",
          app: { slug: "github-actions" },
        })),
      }),
      stderr: "",
    };
  };
  return { gh, calls: () => call };
}

describe("waitForGreen", () => {
  test("an already-green commit passes without waiting", () => {
    const { gh } = ghAnswering([{}]);
    const sleeps: number[] = [];
    const result = waitForGreen("o/r", SHA, {
      gh,
      sleep: (ms) => sleeps.push(ms),
      log: () => {},
    });
    expect(result).toBeNull();
    expect(sleeps).toEqual([]);
  });

  test("a red conclusion fails IMMEDIATELY - waiting cannot turn it green", () => {
    const { gh, calls } = ghAnswering([{ conclusion: "failure" }]);
    const sleeps: number[] = [];
    const result = waitForGreen("o/r", SHA, {
      gh,
      sleep: (ms) => sleeps.push(ms),
      log: () => {},
    });
    expect(result).toContain("concluded 'failure'");
    expect(sleeps).toEqual([]);
    expect(calls()).toBe(1);
  });

  test("an in-progress verdict is waited out to a green one", () => {
    // A dispatched settings run can race the tip's CI run, so the first
    // probes land before a completed verdict; the gate polls instead of
    // failing.
    const { gh, calls } = ghAnswering(
      [{ status: "in_progress", conclusion: null }],
      [{ status: "in_progress", conclusion: null }],
      [{}],
    );
    const sleeps: number[] = [];
    const result = waitForGreen("o/r", SHA, {
      gh,
      deadlineMs: 60_000,
      pollMs: 5,
      sleep: (ms) => sleeps.push(ms),
      log: () => {},
    });
    expect(result).toBeNull();
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([5, 5]);
  });

  test("no verdict by the deadline fails CLOSED, naming the wait", () => {
    const { gh } = ghAnswering([{ status: "in_progress", conclusion: null }]);
    const result = waitForGreen("o/r", SHA, {
      gh,
      deadlineMs: 0,
      pollMs: 5,
      sleep: () => {},
      log: () => {},
    });
    expect(result).toContain("verdict is still 'in_progress'");
    expect(result).toContain("wait for a verdict is over");
  });

  test("a missing verdict is retried (CI and its verdict land after the push), then green", () => {
    // An EMPTY check_runs page must read as pending, not green: the probe
    // count and the sleep prove the gate polled once before passing.
    const { gh, calls } = ghAnswering([], [{}]);
    const sleeps: number[] = [];
    const result = waitForGreen("o/r", SHA, {
      gh,
      deadlineMs: 60_000,
      pollMs: 5,
      sleep: (ms) => sleeps.push(ms),
      log: () => {},
    });
    expect(result).toBeNull();
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([5]);
  });

  test("an API failure gets the deadline, then still fails closed", () => {
    const gh: GhRunner = () => ({ ...NOT_SPAWNED, exitCode: 1, stdout: "", stderr: "boom" });
    const result = waitForGreen("o/r", SHA, {
      gh,
      deadlineMs: 0,
      pollMs: 5,
      sleep: () => {},
      log: () => {},
    });
    expect(result).toContain("check runs failed");
    expect(result).toContain("wait for a verdict is over");
  });

  test("a malformed wait bound THROWS - the CLI wrapper owns the process exit", () => {
    // A non-numeric bound is NaN, every NaN comparison is false, and the
    // wait would run unbounded to the job timeout; and a library function
    // must not process.exit under a future second caller.
    const prior = process.env.GREEN_WAIT_MS;
    process.env.GREEN_WAIT_MS = "junk";
    try {
      const { gh } = ghAnswering([{}]);
      expect(() => waitForGreen("o/r", SHA, { gh, pollMs: 5, sleep: () => {} })).toThrow(
        "GREEN_WAIT_MS must be a non-negative number",
      );
    } finally {
      if (prior === undefined) delete process.env.GREEN_WAIT_MS;
      else process.env.GREEN_WAIT_MS = prior;
    }
  });
});

/** The whole halt for a red tip, the fix included: the gate reads no event
 *  name, so the nightly heal and a dispatch hit this same wall and the one
 *  way past it is a green main. */
const RED_TIP_HALT =
  "refusing the settings apply: commit 000000000000 is not green - its all-green verdict " +
  "concluded 'failure'. This workflow writes settings fleet-wide from this checkout's layer " +
  "files, and its label reconciliation deletes undeclared labels, so it only runs from commits " +
  "CI has vouched for. Fix main (get CI green at this commit, or push a fix): the next nightly " +
  "heal or a manual dispatch then applies.";

describe("tipRefusal", () => {
  test("a green tip is vouched on one probe: null, no sleep", () => {
    const { gh, calls } = ghAnswering([{}]);
    const sleeps: number[] = [];
    const refusal = tipRefusal("o/r", SHA, { gh, sleep: (ms) => sleeps.push(ms), log: () => {} });
    expect(refusal).toBeNull();
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("a red tip halts on the first probe, naming the commit, its verdict, and the fix", () => {
    const { gh, calls } = ghAnswering([{ conclusion: "failure" }]);
    const refusal = tipRefusal("o/r", SHA, { gh, sleep: () => {}, log: () => {} });
    expect(refusal).toBe(RED_TIP_HALT);
    expect(calls()).toBe(1);
  });
});

describe("calledRefusal", () => {
  const OTHER = "00000000000000000000000000000000000000cc";

  test("the run's own green commit passes on ONE probe, no sleep", () => {
    const { gh, calls } = ghAnswering([{}]);
    const sleeps: number[] = [];
    const refusal = calledRefusal("o/r", SHA, SHA, {
      gh,
      wait: { deadlineMs: 60_000, sleepMs: 5, sleep: (ms) => sleeps.push(ms) },
    });
    expect(refusal).toBeNull();
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("a check still in progress on the first read and green on the second passes", () => {
    // The Checks API can report the gate job's just-completed check run as
    // in progress for a moment after that job released this leg: the read
    // polls through it instead of refusing a green commit.
    const { gh, calls } = ghAnswering([{ status: "in_progress", conclusion: null }], [{}]);
    const sleeps: number[] = [];
    const refusal = calledRefusal("o/r", SHA, SHA, {
      gh,
      wait: { deadlineMs: 60_000, sleepMs: 5, sleep: (ms) => sleeps.push(ms) },
    });
    expect(refusal).toBeNull();
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([5]);
  });

  // Past the bound the poll fails CLOSED on every non-green shape. A red
  // conclusion waits the bound out too (the predicate polls for a fresh
  // success because a re-judged sha's verdict can trail a stale one), so
  // the refusal names the conclusion at the bound, not on the first read.
  test.each<{ reason: string; page: Parameters<typeof ghAnswering>[number]; verdict: string }>([
    {
      reason: "a red verdict refuses at the bound",
      page: [{ conclusion: "failure" }],
      verdict: "its all-green verdict concluded 'failure'",
    },
    {
      reason: "a verdict still in progress past the bound refuses",
      page: [{ status: "in_progress", conclusion: null }],
      verdict: "its all-green verdict is still 'in_progress' after 0s",
    },
    {
      reason: "no verdict at all past the bound refuses (the call arrived from somewhere else)",
      page: [],
      verdict:
        "no all-green verdict check exists there (waited 0s) - CI has not vouched for the commit; " +
        "re-run the sha's CI run (the all-green job posts the check) if one should exist",
    },
  ])("$reason", ({ page, verdict }) => {
    const { gh, calls } = ghAnswering(page);
    const sleeps: number[] = [];
    const refusal = calledRefusal("o/r", SHA, SHA, {
      gh,
      wait: { deadlineMs: 0, sleepMs: 5, sleep: (ms) => sleeps.push(ms) },
    });
    expect(refusal).toBe(
      `refusing the called settings apply: commit ${SHA.slice(0, 12)} is not green - ${verdict}. ` +
        "The caller must be needs-ordered behind the all-green job of the same run, so a verdict " +
        "still missing or pending after the wait means the call arrived from somewhere else.",
    );
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test.each([
    {
      reason: "a sha input that is not this run's commit",
      sourceSha: OTHER,
      refusal:
        `refusing the called settings apply: the sha input ${OTHER.slice(0, 12)} is not this ` +
        `run's own commit ${SHA.slice(0, 12)}. A called run applies the judged commit of the CI run ` +
        "that called it (post-green.yml), whose checkouts read that commit; nothing else is vouched for.",
    },
    {
      reason: "a truncated sha input",
      sourceSha: SHA.slice(0, 12),
      refusal: `SOURCE_SHA is not a full commit sha (got '${SHA.slice(0, 12)}')`,
    },
  ])("$reason is refused before any probe", ({ sourceSha, refusal }) => {
    const { gh, calls } = ghAnswering([{}]);
    expect(calledRefusal("o/r", SHA, sourceSha, { gh })).toBe(refusal);
    expect(calls()).toBe(0);
  });
});

describe("the CLI", () => {
  const script = new URL("../../.github/scripts/fleet/require_green_commit.ts", import.meta.url)
    .pathname;

  function runCli(overrides: Record<string, string>, drop: string[] = []): BoundedSpawnResult {
    const env: Record<string, string | undefined> = {
      ...process.env,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SHA: SHA,
      ...overrides,
    };
    for (const name of drop) delete env[name];
    return boundedSpawnSync(["bun", script], { env });
  }

  test("a non-main ref is refused before any probe", () => {
    // A dispatched CI run on a branch counts as a direct event, so
    // without this guard the gate would vouch for an UNMERGED branch tip
    // and the apply would ship its layer files fleet-wide. No network:
    // the refusal must fire before the first probe.
    const proc = runCli({ GITHUB_REF: "refs/heads/feature" });
    expect(proc.exitCode).toBe(1);
    expect(proc.stdout).toContain("refusing the settings apply from");
    expect(proc.stdout).toContain("refs/heads/feature");
  });

  test("an unset GITHUB_REF is refused, never treated as main", () => {
    // Unreachable on a real runner, but this is the one guard between an
    // unmerged branch's layers and the fleet - an empty read must refuse,
    // not skip the check.
    const proc = runCli({}, ["GITHUB_REF"]);
    expect(proc.exitCode).toBe(2);
    expect(proc.stdout).toContain("GITHUB_REF must be set");
  });

  // The script end to end over a gh stub: the halt is exit 1 plus an
  // ::error::, and the gate publishes NO step output on either path.
  test.each([
    {
      reason: "a red tip exits 1 with the halt as an error annotation",
      conclusion: "failure",
      exitCode: 1,
      line: `::error::${RED_TIP_HALT}`,
    },
    {
      reason: "a green tip exits 0 and lets the apply proceed",
      conclusion: "success",
      exitCode: 0,
      line: "commit 000000000000 is green; the settings apply may proceed",
    },
  ])("$reason, publishing no output", ({ conclusion, exitCode, line }) => {
    const bin = dirs.dir("require-green-cli-");
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\nprintf '%s' "$FAKE_CHECK_RUNS"\n`, {
      mode: 0o755,
    });
    const output = join(bin, "github-output");
    const proc = runCli({
      GITHUB_REF: "refs/heads/main",
      GITHUB_OUTPUT: output,
      GREEN_WAIT_MS: "0",
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CHECK_RUNS: JSON.stringify({
        check_runs: [
          {
            name: "all-green",
            status: "completed",
            conclusion,
            external_id: "push",
            app: { slug: "github-actions" },
          },
        ],
      }),
    });
    expect(proc.exitCode).toBe(exitCode);
    expect(proc.stdout.trimEnd().split("\n")).toEqual([line]);
    expect(existsSync(output)).toBe(false);
  });
});
