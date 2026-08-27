// Unit tests for the green-commit predicate both enforcement points share
// (build-branches/publish.ts and sync/resolve_refs.ts). The gh call is
// injected; nothing here touches the network, and the poll's clock is
// zeroed (deadlineMs: 0) except where the poll itself is under test.
// Fail-closed throughout: only a completed, successful all-green verdict
// check run returns null.

import { describe, expect, test } from "bun:test";
import { allGreenFailure, verdictPending } from "../../.github/scripts/shared/all_green.ts";
import type { RunResult } from "../../.github/scripts/shared/proc.ts";

const SHA = "a".repeat(40);
const NO_WAIT = { deadlineMs: 0 };

function ghReturning(
  checks: {
    name?: string;
    status?: string;
    conclusion?: string | null;
    app?: string | null;
    external_id?: string | null;
  }[],
): (command: string[]) => RunResult {
  return () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      check_runs: checks.map((check) => ({
        name: check.name ?? "all-green",
        status: check.status ?? "completed",
        conclusion: check.conclusion === undefined ? "success" : check.conclusion,
        external_id: check.external_id === undefined ? "push" : check.external_id,
        app: check.app === null ? null : { slug: check.app ?? "github-actions" },
      })),
    }),
    stderr: "",
  });
}

describe("allGreenFailure", () => {
  test("queries the sha's all-green check runs by name with filter=latest", () => {
    const calls: string[][] = [];
    const gh = (command: string[]): RunResult => {
      calls.push(command);
      return ghReturning([{}])(command);
    };
    expect(allGreenFailure("Vivswan/repo-platform", SHA, gh, NO_WAIT)).toBeNull();
    expect(calls).toEqual([
      [
        "gh",
        "api",
        `repos/Vivswan/repo-platform/commits/${SHA}/check-runs?check_name=all-green&filter=latest&per_page=100`,
      ],
    ]);
  });

  test("a completed successful verdict is green", () => {
    expect(allGreenFailure("o/r", SHA, ghReturning([{}]), NO_WAIT)).toBeNull();
  });

  test("any success among several verdicts is green (a re-judged sha ran the same tree)", () => {
    const gh = ghReturning([{ conclusion: "failure" }, { conclusion: "success" }]);
    expect(allGreenFailure("o/r", SHA, gh, NO_WAIT)).toBeNull();
  });

  test("a failed verdict names its conclusion", () => {
    const reason = allGreenFailure("o/r", SHA, ghReturning([{ conclusion: "failure" }]), NO_WAIT);
    expect(reason).toContain("concluded 'failure'");
  });

  test("no verdict at all fails closed and names the dispatch unwedge path", () => {
    const reason = allGreenFailure("o/r", SHA, ghReturning([]), NO_WAIT);
    expect(reason).toContain("no all-green verdict check exists");
    expect(reason).toContain("All Green");
  });

  test("an incomplete verdict is not green yet", () => {
    const gh = ghReturning([{ status: "in_progress", conclusion: null }]);
    expect(allGreenFailure("o/r", SHA, gh, NO_WAIT)).toContain("still 'in_progress'");
  });

  test("a look-alike check from another app never vouches", () => {
    const gh = ghReturning([{ app: "some-other-app" }]);
    expect(allGreenFailure("o/r", SHA, gh, NO_WAIT)).toContain("no all-green verdict check");
  });

  test("an app-less check never vouches", () => {
    const gh = ghReturning([{ app: null }]);
    expect(allGreenFailure("o/r", SHA, gh, NO_WAIT)).toContain("no all-green verdict check");
  });

  test("a differently named check never vouches even if the API returns it", () => {
    const gh = ghReturning([{ name: "all-green-ish" }]);
    expect(allGreenFailure("o/r", SHA, gh, NO_WAIT)).toContain("no all-green verdict check");
  });

  test("a pull_request verdict never vouches - a PR run tests the merge tree, not the sha", () => {
    for (const event of ["pull_request", "pull_request_target"]) {
      const gh = ghReturning([{ external_id: event }]);
      expect(allGreenFailure("o/r", SHA, gh, NO_WAIT)).toContain("no all-green verdict check");
    }
  });

  test("legacy job-created checks (opaque or empty external_id) keep vouching", () => {
    // The retired aggregate JOB's checks predate the verdict's event
    // record; the event filter is a blocklist so these stay green.
    for (const externalId of [null, "", "7452900668-check-run"]) {
      const gh = ghReturning([{ external_id: externalId }]);
      expect(allGreenFailure("o/r", SHA, gh, NO_WAIT)).toBeNull();
    }
  });

  test("a missing verdict is polled for under the deadline - the verdict workflow races the caller", () => {
    const responses = [ghReturning([]), ghReturning([]), ghReturning([{}])];
    let probes = 0;
    const gh = (command: string[]): RunResult => {
      const response = responses[Math.min(probes, responses.length - 1)](command);
      probes++;
      return response;
    };
    const sleeps: number[] = [];
    const reason = allGreenFailure("o/r", SHA, gh, {
      deadlineMs: 60_000,
      sleepMs: 5,
      sleep: (ms) => sleeps.push(ms),
    });
    expect(reason).toBeNull();
    expect(probes).toBe(3);
    expect(sleeps).toEqual([5, 5]);
  });

  test("a stale completed failure is polled through - a re-judged sha's fresh success can trail it", () => {
    const responses = [
      ghReturning([{ conclusion: "failure" }]),
      ghReturning([{ conclusion: "failure" }, {}]),
    ];
    let probes = 0;
    const gh = (command: string[]): RunResult => {
      const response = responses[Math.min(probes, responses.length - 1)](command);
      probes++;
      return response;
    };
    const reason = allGreenFailure("o/r", SHA, gh, {
      deadlineMs: 60_000,
      sleepMs: 5,
      sleep: () => {},
    });
    expect(reason).toBeNull();
    expect(probes).toBe(2);
  });

  test("at the deadline a stale failure with no success is the reported reason", () => {
    const reason = allGreenFailure("o/r", SHA, ghReturning([{ conclusion: "cancelled" }]), NO_WAIT);
    expect(reason).toContain("concluded 'cancelled'");
  });

  test("an API failure fails closed with the error's tail, not a pass", () => {
    const gh = (): RunResult => ({ exitCode: 1, stdout: "", stderr: "gh: HTTP 502\n" });
    const reason = allGreenFailure("o/r", SHA, gh, NO_WAIT);
    expect(reason).toContain("gh: HTTP 502");
    expect(reason).toContain("fails closed");
  });

  test("a silent API failure still reports the exit code", () => {
    const gh = (): RunResult => ({ exitCode: 4, stdout: "", stderr: "" });
    expect(allGreenFailure("o/r", SHA, gh, NO_WAIT)).toContain("exit 4");
  });

  test("verdictPending tells REAL pending reasons from final ones through the same strings", () => {
    // Pinned through allGreenFailure's actual output, not copied prose: a
    // reworded reason that desyncs retryability fails here.
    const pending = [
      allGreenFailure("o/r", SHA, ghReturning([]), NO_WAIT),
      allGreenFailure("o/r", SHA, ghReturning([{ status: "queued", conclusion: null }]), NO_WAIT),
      allGreenFailure(
        "o/r",
        SHA,
        () => ({ exitCode: 1, stdout: "", stderr: "gh: HTTP 502\n" }),
        NO_WAIT,
      ),
    ];
    for (const reason of pending) expect(verdictPending(reason ?? "")).toBe(true);
    const final = allGreenFailure("o/r", SHA, ghReturning([{ conclusion: "failure" }]), NO_WAIT);
    expect(verdictPending(final ?? "")).toBe(false);
  });
});
