// fleet-release.yml runs the action with no checkout and every gate reads GitHub through gh: the facts here are
// gh's (list truncation, pagination, 403 for a rate limit too) and GitHub's (case-insensitive labels, an open PR
// listed against a commit it merely contains), none of which the code can enforce for itself.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  findReleasePr,
  type GateOutcome,
  type GhRunner,
  issueGate,
  type Override,
  overrideFromPullRequest,
  parseConfig,
  parseTrackingLabels,
  type ReleaseLookup,
  runHealthCheck,
  securityGate,
} from "../../../actions/release-health/release-health.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();

interface CommitPull {
  number: number;
  head: { ref: string };
  labels: Array<{ name: string }>;
  merged_at?: string | null;
}

interface Fixture {
  issues?: Record<string, number[]>;
  alerts?: number[];
  alertsError?: string;
  /** One inner array per page, as `--paginate --slurp` hands them over. */
  commitPulls?: CommitPull[][];
  prViewLabels?: string[];
}

const REPO = "o/r";

// fleet-release.yml runs the action with no checkout, so gh cannot infer the repository: every call must name it.
function assertNamesRepo(args: string[]): void {
  if (args[0] === "api") {
    const path = args.slice(1).find((arg) => !arg.startsWith("--"));
    if (!path?.startsWith(`repos/${REPO}/`)) {
      throw new Error(`gh api path does not name the repo: ${args.join(" ")}`);
    }
    return;
  }
  if (args[args.indexOf("--repo") + 1] !== REPO) {
    throw new Error(`gh call carries no --repo ${REPO}: ${args.join(" ")}`);
  }
}

function fakeGh(fixture: Fixture): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    assertNamesRepo(args);
    if (args[0] === "issue" && args[1] === "list") {
      const label = args[args.indexOf("--label") + 1] ?? "";
      // gh truncates to --limit (default 30); the fake does the same so
      // over-limit counting is exercised, not hidden.
      const limit = Number(args[args.indexOf("--limit") + 1] ?? 30);
      return JSON.stringify(
        (fixture.issues?.[label] ?? []).slice(0, limit).map((number) => ({ number })),
      );
    }
    if (args[0] === "api" && args[1]?.includes("/dependabot/alerts")) {
      if (fixture.alertsError) {
        throw new Error(fixture.alertsError);
      }
      return JSON.stringify((fixture.alerts ?? []).map((number) => ({ number })));
    }
    if (args[0] === "api" && args.some((arg) => arg.includes("/pulls"))) {
      return JSON.stringify(fixture.commitPulls ?? [[]]);
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (fixture.prViewLabels === undefined) {
        throw new Error("gh pr view failed (1): no pull requests found");
      }
      return JSON.stringify({ labels: fixture.prViewLabels.map((name) => ({ name })) });
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { run, calls };
}

// The payload snapshot carries the override label so that every pull-request row proves the live `gh pr view`
// decides, never the snapshot: a label applied after a failing run to re-run it is absent from the payload,
// and one removed since is still in it.
const eventDir = temp.dir("release-health-");
const eventPath = join(eventDir, "event.json");
writeFileSync(
  eventPath,
  JSON.stringify({
    pull_request: {
      number: 12,
      labels: [{ name: "autorelease: pending" }, { name: "release-override" }],
    },
  }),
);

/** The rejection's exact message; `rejects.toThrow(string)` matches a substring and would pass an appended remedy. */
const rejection = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

function prConfig(overrides: Partial<Config> = {}): Config {
  return {
    context: { mode: "pull-request", eventPath },
    repo: REPO,
    trackingLabels: ["fuzz-nightly"],
    ...overrides,
  };
}

function releaseConfig(overrides: Partial<Config> = {}): Config {
  return { ...prConfig(overrides), context: { mode: "release", sha: "abc123" } };
}

const PR_VIEW_CALL = ["pr", "view", "12", "--repo", REPO, "--json", "labels"];
const COMMIT_PULLS_CALL = [
  "api",
  "--paginate",
  "--slurp",
  "repos/o/r/commits/abc123/pulls?per_page=100",
];
const alertsCall = (severities: string) => [
  "api",
  `repos/o/r/dependabot/alerts?state=open&severity=${severities}&per_page=100`,
];
function issueListCall(label: string): string[] {
  return [
    "issue",
    "list",
    "--repo",
    REPO,
    "--label",
    label,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number",
  ];
}

const RELEASE_BRANCH = "release-please--branches--main";
const MERGED = "2026-08-09T00:00:00Z";
const releasePr = (number: number, labels: string[], merged_at: string | null): CommitPull => ({
  number,
  head: { ref: RELEASE_BRANCH },
  labels: labels.map((name) => ({ name })),
  merged_at,
});
const FEATURE_PR: CommitPull = { number: 3, head: { ref: "feature/x" }, labels: [] };

// GitHub deduplicates label names case-insensitively, so two spellings of one label are one gate.
test.each<{ reason: string; env: string; expected: string[] }>([
  {
    reason: "a repeat differing only in case is one label",
    env: "Fuzz-Nightly,nightly-failure,fuzz-nightly",
    expected: ["Fuzz-Nightly", "nightly-failure"],
  },
  {
    reason: "a whitespace-only token is empty and dropped",
    env: "fuzz-nightly, ,nightly-failure",
    expected: ["fuzz-nightly", "nightly-failure"],
  },
])("parseTrackingLabels: $reason", ({ env, expected }) => {
  expect(parseTrackingLabels({ TRACKING_LABELS: env } as NodeJS.ProcessEnv)).toEqual(expected);
});

describe("issueGate", () => {
  // gh truncates the list at --limit (default 30): a count at the cap is "at least", never a smaller number.
  const overLimit = Array.from({ length: 120 }, (_, i) => i + 1);
  test.each<{ reason: string; open: number[]; expected: GateOutcome }>([
    {
      reason: "no open issue passes",
      open: [],
      expected: { gate: "blocker", status: "pass", summary: "no open 'release-blocker' issues" },
    },
    {
      reason: "open issues fail, each named",
      open: [4, 9],
      expected: {
        gate: "blocker",
        status: "fail",
        problem: "2 open 'release-blocker' issue(s): #4, #9",
        advice: "close them",
      },
    },
    {
      reason: "a count at gh's list limit is reported as at least, never understated",
      open: overLimit,
      expected: {
        gate: "blocker",
        status: "fail",
        problem: `at least 100 open 'release-blocker' issue(s): ${overLimit
          .slice(0, 100)
          .map((n) => `#${n}`)
          .join(", ")}`,
        advice: "close them",
      },
    },
  ])("$reason", async ({ open, expected }) => {
    const { run, calls } = fakeGh({ issues: { "release-blocker": open } });
    const outcome = await issueGate(run, REPO, "blocker", "release-blocker", "close them");
    expect([outcome, calls]).toEqual([expected, [issueListCall("release-blocker")]]);
  });
});

describe("securityGate", () => {
  // The severity list in the query URL is the threshold as it leaves the process; a wider or narrower list
  // changes which alerts the gate ever sees.
  test.each<{
    reason: string;
    threshold: "high" | "critical" | "medium";
    alerts: number[];
    url: string;
    expected: GateOutcome;
  }>([
    {
      reason: "passes at high, querying high and critical alone",
      threshold: "high",
      alerts: [],
      url: "high,critical",
      expected: {
        gate: "security",
        status: "pass",
        summary: "no open Dependabot alerts at or above high",
      },
    },
    {
      reason: "passes at critical, querying critical alone",
      threshold: "critical",
      alerts: [],
      url: "critical",
      expected: {
        gate: "security",
        status: "pass",
        summary: "no open Dependabot alerts at or above critical",
      },
    },
    {
      reason: "fails naming the open alerts",
      threshold: "medium",
      alerts: [1, 2, 3],
      url: "medium,high,critical",
      expected: {
        gate: "security",
        status: "fail",
        problem: "3 open Dependabot alert(s) at or above medium: #1, #2, #3",
        advice: "fix them",
      },
    },
  ])("$reason", async ({ threshold, alerts, url, expected }) => {
    const { run, calls } = fakeGh({ alerts });
    const outcome = await securityGate(run, REPO, threshold, "fix them");
    expect([outcome, calls]).toEqual([expected, [alertsCall(url)]]);
  });

  // Every fleet repository has Dependabot alerts enabled and the callers grant vulnerability-alerts: read,
  // so an unreadable endpoint is a broken gate, never a repository to wave through: an empty pass would ship
  // with open alerts. GitHub answers a primary rate limit with 403 too, so the remedy is named only where
  // the message says configuration is the cause.
  const REMEDY =
    "; the gate needs vulnerability-alerts: read and Dependabot alerts enabled on the repository";
  test.each([
    {
      reason: "a bare 403 (missing vulnerability-alerts grant)",
      message: "gh api failed (1): HTTP 403: Resource not accessible by integration",
      remedy: REMEDY,
      viaRun: true,
    },
    {
      reason: "a server error",
      message: "gh api failed (1): HTTP 500: boom",
      remedy: "",
      viaRun: false,
    },
    {
      reason: "a rate-limited 403",
      message: "gh api failed (1): API rate limit exceeded for installation ID 1 (HTTP 403)",
      remedy: "",
      viaRun: false,
    },
  ])(
    "fails closed on $reason, and runHealthCheck does not catch it",
    async ({ message, remedy, viaRun }) => {
      const { run } = fakeGh({ issues: {}, alertsError: message, prViewLabels: [] });
      const thrown = `security gate could not read the Dependabot alerts (${message})${remedy}`;
      expect(await rejection(securityGate(run, REPO, "high", "advice"))).toBe(thrown);
      if (viaRun) {
        const lines: string[] = [];
        const viaCheck = runHealthCheck(
          prConfig(),
          run,
          (line) => lines.push(line),
          () => {},
        );
        expect([await rejection(viaCheck), lines]).toEqual([thrown, []]);
      }
    },
  );
});

describe("overrideFromPullRequest", () => {
  // The payload snapshot is stale in both directions (a label applied after a failing run to re-run it, or
  // removed since), so the label is read live; a failed read fails closed rather than trusting the snapshot.
  test.each<{ reason: string; prViewLabels: string[] | undefined; override: Override | null }>([
    {
      reason: "exact spelling",
      prViewLabels: ["release-override"],
      override: { active: true, prNumber: 12 },
    },
    {
      reason: "case-insensitively, the way GitHub deduplicates labels",
      prViewLabels: ["Release-Override"],
      override: { active: true, prNumber: 12 },
    },
    {
      reason: "no label on the live PR means no override, naming the PR, whatever the payload says",
      prViewLabels: ["autorelease: pending"],
      override: { active: false, reason: "no 'release-override' label on PR #12" },
    },
    {
      reason:
        "a failed live lookup propagates through the run instead of trusting the payload's label",
      prViewLabels: undefined,
      override: null,
    },
  ])("via a live gh pr view naming the repo: $reason", async ({ prViewLabels, override }) => {
    const { run, calls } = fakeGh({ issues: {}, alerts: [], prViewLabels });
    const lookup = overrideFromPullRequest(run, REPO, eventPath, "release-override");
    if (override === null) {
      await expect(lookup).rejects.toThrow("gh pr view failed");
      await expect(
        runHealthCheck(
          prConfig(),
          run,
          () => {},
          () => {},
        ),
      ).rejects.toThrow("gh pr view failed");
    } else {
      expect([await lookup, calls]).toEqual([override, [PR_VIEW_CALL]]);
    }
  });
});

describe("findReleasePr", () => {
  // GitHub lists every PR whose branch CONTAINS the commit, open ones included: an open release PR rides along
  // with an ordinary push and must not count as the cut, and on a busy repository the merged one sits past
  // page one. The `release-please--` prefix is release-please's branch convention; `--paginate --slurp` needs gh >= 2.51.
  test.each<{ reason: string; pages: CommitPull[][]; expected: ReleaseLookup | "rejects" }>([
    {
      reason: "the merged PR whose head ref is a release-please branch",
      pages: [[FEATURE_PR, releasePr(5, ["l"], MERGED)]],
      expected: { pr: { number: 5, labels: ["l"] }, unmerged: [] },
    },
    {
      reason: "a release PR on a later page is still found",
      pages: [
        Array.from({ length: 100 }, (_, i) => ({
          number: i + 100,
          head: { ref: `fix/${i}` },
          labels: [],
        })),
        [releasePr(5, ["l"], MERGED)],
      ],
      expected: { pr: { number: 5, labels: ["l"] }, unmerged: [] },
    },
    {
      reason: "no associated release PR means no merge and nothing unmerged",
      pages: [[{ number: 3, head: { ref: "fix/y" }, labels: [] }]],
      expected: { pr: undefined, unmerged: [] },
    },
    {
      reason: "a single UNMERGED candidate is not a merge, its labels unread",
      pages: [[releasePr(8, ["release-override"], null)]],
      expected: { pr: undefined, unmerged: [8] },
    },
    {
      reason: "with several release-please PRs, only the merged one wins",
      pages: [
        [
          {
            number: 4,
            head: { ref: "release-please--branches--next" },
            labels: [],
            merged_at: null,
          },
          releasePr(6, ["l"], MERGED),
        ],
      ],
      expected: { pr: { number: 6, labels: ["l"] }, unmerged: [4] },
    },
    {
      reason: "more than one MERGED release-please PR fails closed naming the numbers",
      pages: [
        [
          {
            number: 4,
            head: { ref: "release-please--branches--next" },
            labels: [],
            merged_at: "2026-08-08T00:00:00Z",
          },
          releasePr(6, [], MERGED),
        ],
      ],
      expected: "rejects",
    },
  ])("$reason", async ({ pages, expected }) => {
    const { run, calls } = fakeGh({ commitPulls: pages });
    const lookup = findReleasePr(run, REPO, "abc123");
    if (expected === "rejects") await expect(lookup).rejects.toThrow("#4, #6");
    else expect(await lookup).toEqual(expected);
    expect(calls).toEqual([COMMIT_PULLS_CALL]);
  });
});

describe("runHealthCheck", () => {
  interface Run {
    exit: number;
    lines: string[];
    outputs: string[];
    calls: string[][];
  }
  async function run(config: Config, fixture: Fixture): Promise<Run> {
    const gh = fakeGh(fixture);
    const lines: string[] = [];
    const outputs: string[] = [];
    const exit = await runHealthCheck(
      config,
      gh.run,
      (line) => lines.push(line),
      (name, value) => outputs.push(`${name}=${value}`),
    );
    return { exit, lines, outputs, calls: gh.calls };
  }

  // The advice each gate family attaches to its ::error line, pinned verbatim: it is the operator's only
  // instruction when a release is blocked, and `::error::` is GitHub's workflow-command surface (a misspelled
  // command is plain log text, silently).
  const OVERRIDE_HINT =
    "or apply the 'release-override' label to the release PR and re-run this check";
  const TRACKING_ADVICE = `fix the failures behind it (the stream's next green nightly run closes the tracking issue automatically), ${OVERRIDE_HINT}`;
  const BLOCKER_ADVICE = `close the blocker issue(s), ${OVERRIDE_HINT}`;
  const SECURITY_ADVICE = `fix or dismiss the alert(s) under the repository's Security tab, ${OVERRIDE_HINT}`;
  const PR_CALLS = (labels: string[]) => [
    PR_VIEW_CALL,
    ...labels.map(issueListCall),
    issueListCall("release-blocker"),
    alertsCall("high,critical"),
  ];

  // Every gate runs even under the override, so the report is complete; only release mode sets an output.
  // The multi-label row reads its Config through parseConfig from the env action.yml sets, so the wiring from
  // TRACKING_LABELS to the gates is executed once: a parser that dropped the labels would run no tracking
  // gate and pass, green.
  test.each<{ reason: string; config: Config; fixture: Fixture; expected: Run }>([
    {
      reason: "all gates green is a one-line success",
      config: prConfig(),
      fixture: { issues: {}, alerts: [], prViewLabels: [] },
      expected: {
        exit: 0,
        lines: [
          "release health: all gates passed (tracking:fuzz-nightly: no open 'fuzz-nightly' issues; blocker: no open 'release-blocker' issues; security: no open Dependabot alerts at or above high)",
        ],
        outputs: [],
        calls: PR_CALLS(["fuzz-nightly"]),
      },
    },
    {
      reason: "an empty tracking-label list runs no tracking gate",
      config: prConfig({ trackingLabels: [] }),
      fixture: { issues: {}, alerts: [], prViewLabels: [] },
      expected: {
        exit: 0,
        lines: [
          "release health: all gates passed (blocker: no open 'release-blocker' issues; security: no open Dependabot alerts at or above high)",
        ],
        outputs: [],
        calls: PR_CALLS([]),
      },
    },
    {
      reason: "each tracking label from the env is its own gate, queried and reported by label",
      config: parseConfig({
        GITHUB_REPOSITORY: REPO,
        MODE: "pull-request",
        GITHUB_EVENT_PATH: eventPath,
        TRACKING_LABELS: "fuzz-nightly,nightly-failure",
      } as NodeJS.ProcessEnv),
      fixture: {
        issues: { "fuzz-nightly": [], "nightly-failure": [3], "release-blocker": [] },
        alerts: [],
        prViewLabels: [],
      },
      expected: {
        exit: 1,
        lines: [
          `::error::tracking:nightly-failure gate failed: 1 open 'nightly-failure' issue(s): #3. To release: ${TRACKING_ADVICE}`,
        ],
        outputs: [],
        calls: PR_CALLS(["fuzz-nightly", "nightly-failure"]),
      },
    },
    {
      reason: "each failing gate is an ::error with its advice, exit 1",
      config: prConfig(),
      fixture: {
        issues: { "fuzz-nightly": [2], "release-blocker": [7] },
        alerts: [11],
        prViewLabels: [],
      },
      expected: {
        exit: 1,
        lines: [
          `::error::tracking:fuzz-nightly gate failed: 1 open 'fuzz-nightly' issue(s): #2. To release: ${TRACKING_ADVICE}`,
          `::error::blocker gate failed: 1 open 'release-blocker' issue(s): #7. To release: ${BLOCKER_ADVICE}`,
          `::error::security gate failed: 1 open Dependabot alert(s) at or above high: #11. To release: ${SECURITY_ADVICE}`,
        ],
        outputs: [],
        calls: PR_CALLS(["fuzz-nightly"]),
      },
    },
    {
      reason:
        "the override turns failures into warnings plus a loud notice, exit 0, every gate still run",
      config: prConfig(),
      fixture: {
        issues: { "fuzz-nightly": [], "release-blocker": [7] },
        alerts: [5],
        prViewLabels: ["release-override"],
      },
      expected: {
        exit: 0,
        lines: [
          "::warning::blocker gate failed: 1 open 'release-blocker' issue(s): #7",
          "::warning::security gate failed: 1 open Dependabot alert(s) at or above high: #5",
          "::notice::OVERRIDE: the 'release-override' label on release PR #12 bypassed 2 failing gate(s) (blocker, security); this release ships despite them",
        ],
        outputs: [],
        calls: PR_CALLS(["fuzz-nightly"]),
      },
    },
  ])("pull-request mode: $reason", async ({ config, fixture, expected }) => {
    expect(await run(config, fixture)).toEqual(expected);
  });

  // `release-cut` is fleet-release.yml's switch: "true" tags the release-PR merge and drafts the release, "false"
  // proposes or refreshes the release PR. Swapped, a green release merge re-proposes itself and an ordinary
  // push is tagged, both green; a red release merge keeps "true" so the pair is judged whatever the exit.
  test.each<{ reason: string; fixture: Fixture; expected: Run }>([
    {
      reason: "the override is read from the commit's merged release PR",
      fixture: {
        issues: { "fuzz-nightly": [], "release-blocker": [7] },
        alerts: [],
        commitPulls: [[releasePr(21, ["release-override"], MERGED)]],
      },
      expected: {
        exit: 0,
        lines: [
          "::warning::blocker gate failed: 1 open 'release-blocker' issue(s): #7",
          "::notice::OVERRIDE: the 'release-override' label on release PR #21 bypassed 1 failing gate(s) (blocker); this release ships despite them",
        ],
        outputs: ["release-cut=true"],
        calls: [
          COMMIT_PULLS_CALL,
          issueListCall("fuzz-nightly"),
          issueListCall("release-blocker"),
          alertsCall("high,critical"),
        ],
      },
    },
    {
      reason: "a release-PR merge with a red gate and no override fails",
      fixture: {
        issues: { "fuzz-nightly": [], "release-blocker": [7] },
        alerts: [],
        commitPulls: [[releasePr(21, [], MERGED)]],
      },
      expected: {
        exit: 1,
        lines: [
          `::error::blocker gate failed: 1 open 'release-blocker' issue(s): #7. To release: ${BLOCKER_ADVICE}`,
        ],
        outputs: ["release-cut=true"],
        calls: [
          COMMIT_PULLS_CALL,
          issueListCall("fuzz-nightly"),
          issueListCall("release-blocker"),
          alertsCall("high,critical"),
        ],
      },
    },
    {
      reason: "a push that is not a release-PR merge is not gated at all",
      fixture: { issues: { "release-blocker": [7] }, commitPulls: [[FEATURE_PR]] },
      expected: {
        exit: 0,
        lines: ["::notice::release health: abc123 is not a release-PR merge; nothing to gate"],
        outputs: ["release-cut=false"],
        calls: [COMMIT_PULLS_CALL],
      },
    },
    {
      reason:
        "a single UNMERGED release PR is the trivial pass, naming it, its override label unread",
      fixture: {
        issues: { "release-blocker": [7] },
        commitPulls: [[releasePr(9, ["release-override"], null)]],
      },
      expected: {
        exit: 0,
        lines: [
          "::notice::release health: abc123 is not a release-PR merge; nothing to gate (open release PR(s) associated: #9)",
        ],
        outputs: ["release-cut=false"],
        calls: [COMMIT_PULLS_CALL],
      },
    },
  ])("release mode: $reason", async ({ fixture, expected }) => {
    expect(await run(releaseConfig(), fixture)).toEqual(expected);
  });
});
