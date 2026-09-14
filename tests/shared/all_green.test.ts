import { describe, expect, test } from "bun:test";
import {
  allGreenFailure,
  type GhRunner,
  verdictPending,
} from "../../.github/scripts/shared/all_green.ts";
import type { RunResult } from "../../.github/scripts/shared/proc.ts";

const SHA = "a".repeat(40);
const NO_WAIT = { deadlineMs: 0 };

function ghReturning(
  checks: {
    name?: string;
    status?: string;
    conclusion?: string | null;
    app?: string | null;
  }[],
): (command: string[]) => RunResult {
  return () => ({
    exitCode: 0,
    timedOut: false,
    stdout: JSON.stringify({
      check_runs: checks.map((check) => ({
        name: check.name ?? "all-green",
        status: check.status ?? "completed",
        conclusion: check.conclusion === undefined ? "success" : check.conclusion,
        app: check.app === null ? null : { slug: check.app ?? "github-actions" },
      })),
    }),
    stderr: "",
    pid: 0,
  });
}

const ghFailing =
  (exitCode: number, stderr: string): GhRunner =>
  () => ({
    exitCode,
    stdout: "",
    stderr,
    timedOut: false,
    pid: 0,
  });

describe("allGreenFailure", () => {
  // filter=latest is GitHub's: without it a re-run's stale check run is listed beside the fresh one.
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

  // Pinned as the WHOLE reason string: the prose is what verdictPending matches
  // and what lands in the sync and publish logs, so a reworded fragment fails
  // here rather than drifting. The app filter is GitHub's: a third-party app
  // can post a check named all-green.
  const NO_CHECK =
    "no all-green verdict check exists there (waited 0s) - CI has not vouched for the commit; re-run the sha's CI run (the all-green job posts the check) if one should exist";
  const API_FAILURE = (detail: string) =>
    `reading its all-green check runs failed (${detail}) - an API failure, not proof the commit is red, but the gate fails closed`;
  const verdicts: [string, GhRunner, string | null][] = [
    ["a completed successful verdict is green", ghReturning([{}]), null],
    [
      "any success among several verdicts is green (a re-judged sha ran the same tree)",
      ghReturning([{ conclusion: "failure" }, {}]),
      null,
    ],
    [
      "a failed verdict names its conclusion",
      ghReturning([{ conclusion: "failure" }]),
      "its all-green verdict concluded 'failure'",
    ],
    [
      "at the deadline a stale failure with no success is the reported reason",
      ghReturning([{ conclusion: "cancelled" }]),
      "its all-green verdict concluded 'cancelled'",
    ],
    ["no check at all fails closed and names the re-run unwedge path", ghReturning([]), NO_CHECK],
    [
      "a look-alike check from another app never vouches",
      ghReturning([{ app: "some-other-app" }]),
      NO_CHECK,
    ],
    ["an app-less check never vouches", ghReturning([{ app: null }]), NO_CHECK],
    [
      "a differently named check never vouches even if the API returns it",
      ghReturning([{ name: "all-green-ish" }]),
      NO_CHECK,
    ],
    [
      "an incomplete verdict is not green yet",
      ghReturning([{ status: "in_progress", conclusion: null }]),
      "its all-green verdict is still 'in_progress' after 0s",
    ],
    [
      "an API failure fails closed with the error's tail, not a pass",
      ghFailing(1, "gh: HTTP 502\n"),
      API_FAILURE("gh: HTTP 502"),
    ],
    [
      "a multi-line gh failure reports its LAST line (gh's offline diagnostic puts the detail second)",
      ghFailing(
        1,
        "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n",
      ),
      API_FAILURE("check your internet connection or https://githubstatus.com"),
    ],
    ["a silent API failure still reports the exit code", ghFailing(4, ""), API_FAILURE("exit 4")],
  ];
  test.each(verdicts)("%s", (_reason, gh, expected) => {
    expect(allGreenFailure("o/r", SHA, gh, NO_WAIT)).toBe(expected);
  });

  test("a missing check is polled for under the deadline - a fresh run's check races the caller", () => {
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

  test("verdictPending tells REAL pending reasons from final ones through the same strings", () => {
    // Pinned through allGreenFailure's actual output, not copied prose: a
    // reworded reason that desyncs retryability fails here.
    const pending = [
      allGreenFailure("o/r", SHA, ghReturning([]), NO_WAIT),
      allGreenFailure("o/r", SHA, ghReturning([{ status: "queued", conclusion: null }]), NO_WAIT),
      allGreenFailure("o/r", SHA, ghFailing(1, "gh: HTTP 502\n"), NO_WAIT),
    ];
    for (const reason of pending) expect(verdictPending(reason ?? "")).toBe(true);
    const final = allGreenFailure("o/r", SHA, ghReturning([{ conclusion: "failure" }]), NO_WAIT);
    expect(verdictPending(final ?? "")).toBe(false);
  });
});
