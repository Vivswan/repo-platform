// Unit tests for the settings apply's green gate: the bounded wait a
// push-triggered run does for its own commit's all-green verdict, and the
// hard, fail-closed refusals around it. The gh probe, the clock, and the
// sleep are injected so nothing here touches the network or actually
// waits (waitForGreen zeroes the predicate's internal poll - this loop
// owns all waiting).

import { describe, expect, test } from "bun:test";
import { waitForGreen } from "../../.github/scripts/fleet/require_green_commit";
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
