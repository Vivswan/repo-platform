// Unit tests for the settings apply's green gate: the bounded wait a
// push-triggered run does for its own commit's all-green verdict, the
// hard, fail-closed refusals around it, and the trigger split - push and
// dispatch stay tip-gated while the scheduled heal falls back to the
// newest green commit behind a red tip. The gh probe, the clock, the
// sleep, and the walk are injected so nothing here touches the network or
// actually waits (waitForGreen zeroes the predicate's internal poll -
// this loop owns all waiting).

import { describe, expect, test } from "bun:test";
import type { GreenWalkOutcome } from "../../.github/scripts/fleet/newest_green_commit";
import { decideGreenCommit, waitForGreen } from "../../.github/scripts/fleet/require_green_commit";
import type { GhRunner } from "../../.github/scripts/shared/all_green.ts";
import { type BoundedSpawnResult, boundedSpawnSync } from "../shared/bounded_spawn";

const SHA = "000000000000000000000000000000000000000a";

function ghAnswering(...pages: { status?: string; conclusion?: string | null }[][]): {
  gh: GhRunner;
  calls: () => number;
} {
  let call = 0;
  const gh: GhRunner = () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call++;
    return {
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
    // The push-triggered settings run races its own commit's CI run AND
    // the verdict workflow behind it, so the first probes land before a
    // completed verdict; the gate polls instead of failing.
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
    const gh: GhRunner = () => ({ exitCode: 1, stdout: "", stderr: "boom" });
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

describe("decideGreenCommit", () => {
  const GREEN_BEHIND = "00000000000000000000000000000000000000bb";

  function walkSpy(outcome: GreenWalkOutcome): {
    walk: (repository: string, tip: string) => GreenWalkOutcome;
    calls: () => number;
  } {
    let calls = 0;
    return {
      walk: () => {
        calls++;
        return outcome;
      },
      calls: () => calls,
    };
  }

  test("a green tip applies from the tip, on every trigger, and the walk NEVER runs", () => {
    for (const event of ["push", "workflow_dispatch", "schedule"]) {
      const { gh } = ghAnswering([{}]);
      const spy = walkSpy({ sha: GREEN_BEHIND, behind: 1 });
      const decision = decideGreenCommit("o/r", SHA, event, {
        gh,
        sleep: () => {},
        log: () => {},
        walk: spy.walk,
      });
      expect(decision).toEqual({ sha: SHA, fallback: false });
      expect(spy.calls()).toBe(0);
    }
  });

  // Push and dispatch stay tip-gated - applying THAT commit is the run's
  // point, and only the schedule may fall back. An unset event name (never
  // the case on a real runner) lands on the same strict branch: anything
  // that is not the schedule stays tip-gated, so an unknown trigger can
  // never inherit the fallback.
  test.each(["push", "workflow_dispatch", ""])(
    "a red tip on a %j run refuses tip-gated and never walks",
    (event) => {
      const { gh } = ghAnswering([{ conclusion: "failure" }]);
      const spy = walkSpy({ sha: GREEN_BEHIND, behind: 1 });
      const decision = decideGreenCommit("o/r", SHA, event, {
        gh,
        sleep: () => {},
        log: () => {},
        walk: spy.walk,
      });
      expect(decision).toEqual({
        refusal: expect.stringContaining(
          "refusing the settings apply: commit 000000000000 is not green - ",
        ),
      });
      expect(spy.calls()).toBe(0);
    },
  );

  test("a red tip on the SCHEDULED heal falls back to the walk's green commit, evidence attached", () => {
    const { gh } = ghAnswering([{ conclusion: "failure" }]);
    const spy = walkSpy({ sha: GREEN_BEHIND, behind: 3 });
    const decision = decideGreenCommit("o/r", SHA, "schedule", {
      gh,
      sleep: () => {},
      log: () => {},
      walk: spy.walk,
    });
    expect(decision).toEqual({
      sha: GREEN_BEHIND,
      fallback: true,
      behind: 3,
      tipReason: expect.stringContaining("concluded 'failure'"),
    });
    expect(spy.calls()).toBe(1);
  });

  test("a scheduled heal whose walk finds nothing refuses loudly, naming BOTH reasons", () => {
    // The old halt as the floor: red tip, exhausted walk, no apply - and
    // the refusal carries the tip's reason plus the walk's, so the halted
    // run's log says exactly what to fix.
    const { gh } = ghAnswering([{ conclusion: "failure" }]);
    const spy = walkSpy({ sha: null, refusal: "no green commit within 50 commits behind the tip" });
    const decision = decideGreenCommit("o/r", SHA, "schedule", {
      gh,
      sleep: () => {},
      log: () => {},
      walk: spy.walk,
    });
    expect("refusal" in decision).toBe(true);
    if ("refusal" in decision) {
      expect(decision.refusal).toContain("refusing the scheduled settings heal");
      expect(decision.refusal).toContain("concluded 'failure'");
      expect(decision.refusal).toContain("no green commit within 50 commits");
      expect(decision.refusal).toContain("stays halted");
    }
  });
});

describe("the CLI's ref guard", () => {
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
});
