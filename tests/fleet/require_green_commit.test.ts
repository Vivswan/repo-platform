// Unit tests for the settings apply's green gate: the bounded wait a
// push-triggered run does for its own commit's CI verdict, and the hard,
// fail-closed refusals around it. The gh probe, the clock, and the sleep
// are injected so nothing here touches the network or actually waits.

import { describe, expect, test } from "bun:test";
import { waitForGreen } from "../../.github/scripts/fleet/require_green_commit";
import type { GhRunner } from "../../.github/scripts/shared/all_green.ts";

const SHA = "000000000000000000000000000000000000000a";

function ghAnswering(
  ...runs: { event?: string; status?: string; conclusion?: string | null }[][]
): { gh: GhRunner; calls: () => number } {
  let call = 0;
  const gh: GhRunner = () => {
    const page = runs[Math.min(call, runs.length - 1)];
    call++;
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        workflow_runs: page.map((run) => ({
          event: run.event ?? "push",
          status: run.status ?? "completed",
          conclusion: run.conclusion === undefined ? "success" : run.conclusion,
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

  test("an in-progress run is waited out to a green verdict", () => {
    // The push-triggered settings run races its own commit's CI run, so
    // the first probes land mid-run; the gate polls instead of failing.
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
    expect(result).toContain("is still 'in_progress'");
    expect(result).toContain("wait for a verdict is over");
  });

  test("a missing CI run is retried (it appears seconds after the push), then green", () => {
    const { gh } = ghAnswering([], [{}]);
    const result = waitForGreen("o/r", SHA, {
      gh,
      deadlineMs: 60_000,
      pollMs: 5,
      sleep: () => {},
      log: () => {},
    });
    expect(result).toBeNull();
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
    expect(result).toContain("reading its CI runs failed");
    expect(result).toContain("wait for a verdict is over");
  });
});

describe("the CLI's ref guard", () => {
  test("a non-main ref is refused before any probe", () => {
    // A dispatched CI run on a branch counts as a direct event, so
    // without this guard the gate would vouch for an UNMERGED branch tip
    // and the apply would ship its layer files fleet-wide. No network:
    // the refusal must fire before the first probe.
    const script = new URL("../../.github/scripts/fleet/require_green_commit.ts", import.meta.url)
      .pathname;
    const proc = Bun.spawnSync(["bun", script], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_SHA: SHA,
        GITHUB_REF: "refs/heads/feature",
      },
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stdout.toString()).toContain("refusing the settings apply from");
    expect(proc.stdout.toString()).toContain("refs/heads/feature");
  });
});
