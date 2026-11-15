import { describe, expect, test } from "bun:test";
import { allGreenFailure, verdictPending } from "../../.github/scripts/shared/all_green.ts";
import { clientOver, type FakeReply } from "./fake_github";

const SHA = "a".repeat(40);
const NO_WAIT = { deadlineMs: 0 };
const CHECK_RUNS = `repos/o/r/commits/${SHA}/check-runs`;

/** One check-runs reply, each check defaulting to the gate's own green verdict. */
function listing(
  checks: {
    name?: string;
    status?: string;
    conclusion?: string | null;
    app?: string | null;
  }[],
): FakeReply {
  return {
    status: 200,
    body: {
      check_runs: checks.map((check) => ({
        name: check.name ?? "all-green",
        status: check.status ?? "completed",
        conclusion: check.conclusion === undefined ? "success" : check.conclusion,
        app: check.app === null ? null : { slug: check.app ?? "github-actions" },
      })),
    },
  };
}

/** The client and its request log over the replies the check-runs read gets, in order. */
const answering = (...replies: FakeReply[]) => clientOver({ [CHECK_RUNS]: replies });

describe("allGreenFailure", () => {
  // Pinned explicitly: GitHub's default is latest today, and `all` would list a re-run's stale check run beside the
  // fresh one.
  test("queries the sha's all-green check runs by name with filter=latest", async () => {
    const { client, github } = answering(listing([{}]));
    expect(await allGreenFailure("o/r", SHA, client, NO_WAIT)).toBeNull();
    expect(github.calls().map((call) => call.path)).toEqual([
      `${CHECK_RUNS}?check_name=all-green&filter=latest&per_page=100`,
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
  const verdicts: [string, FakeReply, string | null][] = [
    ["a completed successful verdict is green", listing([{}]), null],
    [
      "any success among several verdicts is green (a re-judged sha ran the same tree)",
      listing([{ conclusion: "failure" }, {}]),
      null,
    ],
    [
      "a failed verdict names its conclusion",
      listing([{ conclusion: "failure" }]),
      "its all-green verdict concluded 'failure'",
    ],
    [
      "at the deadline a stale failure with no success is the reported reason",
      listing([{ conclusion: "cancelled" }]),
      "its all-green verdict concluded 'cancelled'",
    ],
    ["no check at all fails closed and names the re-run unwedge path", listing([]), NO_CHECK],
    [
      "a look-alike check from another app never vouches",
      listing([{ app: "some-other-app" }]),
      NO_CHECK,
    ],
    ["an app-less check never vouches", listing([{ app: null }]), NO_CHECK],
    [
      "a differently named check never vouches even if the API returns it",
      listing([{ name: "all-green-ish" }]),
      NO_CHECK,
    ],
    [
      "an incomplete verdict is not green yet",
      listing([{ status: "in_progress", conclusion: null }]),
      "its all-green verdict is still 'in_progress' after 0s",
    ],
    [
      "an API failure fails closed with its status, not a pass",
      { status: 502 },
      API_FAILURE("HTTP 502"),
    ],
    [
      "a sha GitHub does not know fails closed like any failed read",
      { status: 404 },
      API_FAILURE("HTTP 404"),
    ],
  ];
  test.each(verdicts)("%s", async (_reason, reply, expected) => {
    expect(await allGreenFailure("o/r", SHA, answering(reply).client, NO_WAIT)).toBe(expected);
  });

  test("a missing check is polled for under the deadline - a fresh run's check races the caller", async () => {
    const { client, github } = answering(listing([]), listing([]), listing([{}]));
    const sleeps: number[] = [];
    const reason = await allGreenFailure("o/r", SHA, client, {
      deadlineMs: 60_000,
      sleepMs: 5,
      sleep: (ms) => sleeps.push(ms),
    });
    expect(reason).toBeNull();
    expect(github.calls().length).toBe(3);
    expect(sleeps).toEqual([5, 5]);
  });

  test("a stale completed failure is polled through - a re-judged sha's fresh success can trail it", async () => {
    const { client, github } = answering(
      listing([{ conclusion: "failure" }]),
      listing([{ conclusion: "failure" }, {}]),
    );
    const reason = await allGreenFailure("o/r", SHA, client, {
      deadlineMs: 60_000,
      sleepMs: 5,
      sleep: () => {},
    });
    expect(reason).toBeNull();
    expect(github.calls().length).toBe(2);
  });

  test("verdictPending tells REAL pending reasons from final ones through the same strings", async () => {
    // Pinned through allGreenFailure's actual output, not copied prose: a
    // reworded reason that desyncs retryability fails here.
    const reasonOf = (reply: FakeReply) =>
      allGreenFailure("o/r", SHA, answering(reply).client, NO_WAIT);
    const pending = [
      await reasonOf(listing([])),
      await reasonOf(listing([{ status: "queued", conclusion: null }])),
      await reasonOf({ status: 502 }),
    ];
    for (const reason of pending) expect(verdictPending(reason ?? "")).toBe(true);
    const final = await reasonOf(listing([{ conclusion: "failure" }]));
    expect(verdictPending(final ?? "")).toBe(false);
  });
});
