/**
 * Unit tests for the release-health action: config parsing, each gate, the
 * override resolution in both modes, and the end-to-end outcome through an
 * injected fake gh runner. The real gh calls are not tested here (they need
 * a live GitHub).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  findReleasePr,
  type GateOutcome,
  type GhRunner,
  issueGate,
  LABEL_RE,
  overrideFromPullRequest,
  parseConfig,
  parseTrackingLabels,
  runHealthCheck,
  securityGate,
  severitiesAtOrAbove,
} from "./release-health";

/**
 * A recording gh runner: captures every command and answers issue-list,
 * dependabot-alert, commit-pulls, and pr-view queries from the fixture.
 * Like the real CI environment (the fleet gate job runs with no checkout),
 * it refuses any call that does not name the repository explicitly.
 */
interface Fixture {
  /** Open issue numbers per label. */
  issues?: Record<string, number[]>;
  /** Open Dependabot alert numbers (returned for any severity query). */
  alerts?: number[];
  /** Error message thrown by the alerts endpoint instead of answering. */
  alertsError?: string;
  /** PRs returned by the commit->pulls lookup. */
  commitPulls?: Array<{
    number: number;
    head: { ref: string };
    labels: Array<{ name: string }>;
    merged_at?: string | null;
  }>;
  /** Labels returned by `gh pr view`; undefined makes pr view fail. */
  prViewLabels?: string[];
}

const REPO = "o/r";

function assertNamesRepo(args: string[]): void {
  if (args[0] === "api") {
    // The endpoint path is the first non-flag argument after "api"
    // (flags like --paginate may precede it).
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
      // --paginate --slurp wraps the pages in one array; the fake returns a
      // single page holding the fixture's PRs.
      return JSON.stringify([fixture.commitPulls ?? []]);
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

// Created at load so the parametrized tables below can name the path.
const eventDir = mkdtempSync(join(tmpdir(), "release-health-"));
const eventPath = join(eventDir, "event.json");
writeFileSync(
  eventPath,
  JSON.stringify({ pull_request: { number: 12, labels: [{ name: "autorelease: pending" }] } }),
);

afterAll(() => {
  rmSync(eventDir, { recursive: true, force: true });
});

const baseEnv = {
  GITHUB_REPOSITORY: "o/r",
  GITHUB_SHA: "abc123",
} as NodeJS.ProcessEnv;

function prConfig(overrides: Partial<Config> = {}): Config {
  return {
    context: { mode: "pull-request", eventPath },
    repo: "o/r",
    trackingLabels: ["fuzz-nightly"],
    legacyFuzzLabel: undefined,
    blockerLabel: "release-blocker",
    overrideLabel: "release-override",
    security: "high",
    ...overrides,
  };
}

function releaseConfig(overrides: Partial<Config> = {}): Config {
  return { ...prConfig(overrides), context: { mode: "release", sha: "abc123" } };
}

/** The exact gh commands the action issues, for whole-transcript pins. */
const PR_VIEW_CALL = ["pr", "view", "12", "--repo", REPO, "--json", "labels"];
const COMMIT_PULLS_CALL = [
  "api",
  "--paginate",
  "--slurp",
  "repos/o/r/commits/abc123/pulls?per_page=100",
];
const ALERTS_HIGH_CALL = [
  "api",
  "repos/o/r/dependabot/alerts?state=open&severity=high,critical&per_page=100",
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

describe("parseConfig", () => {
  const defaults: Omit<Config, "context"> = {
    repo: "o/r",
    trackingLabels: [],
    legacyFuzzLabel: undefined,
    blockerLabel: "release-blocker",
    overrideLabel: "release-override",
    security: "high",
  };
  const cases: Array<{ reason: string; env: Record<string, string>; expected: Config }> = [
    {
      reason: "pull-request mode with every optional input at its default",
      env: { MODE: "pull-request", GITHUB_EVENT_PATH: eventPath },
      expected: { ...defaults, context: { mode: "pull-request", eventPath } },
    },
    {
      reason: "release mode with every non-deprecated input set explicitly",
      env: {
        MODE: "release",
        TRACKING_LABELS: "fuzz-nightly,nightly-failure",
        BLOCKER_LABEL: "no-ship",
        OVERRIDE_LABEL: "ship-anyway",
        SECURITY_SEVERITY: "critical",
      },
      expected: {
        context: { mode: "release", sha: "abc123" },
        repo: "o/r",
        trackingLabels: ["fuzz-nightly", "nightly-failure"],
        legacyFuzzLabel: undefined,
        blockerLabel: "no-ship",
        overrideLabel: "ship-anyway",
        security: "critical",
      },
    },
    {
      reason: "off as the security threshold (disables the gate, not a severity)",
      env: { MODE: "release", SECURITY_SEVERITY: "off" },
      expected: { ...defaults, context: { mode: "release", sha: "abc123" }, security: "off" },
    },
  ];
  test.each(cases)("parses $reason", ({ env, expected }) => {
    expect(parseConfig({ ...baseEnv, ...env })).toEqual(expected);
  });

  test("rejects an unknown mode, a missing mode, and mode-specific context", () => {
    expect(() => parseConfig({ ...baseEnv, MODE: "push" } as NodeJS.ProcessEnv)).toThrow(
      "unknown MODE",
    );
    expect(() => parseConfig({ ...baseEnv } as NodeJS.ProcessEnv)).toThrow("unknown MODE");
    expect(() => parseConfig({ ...baseEnv, MODE: "pull-request" } as NodeJS.ProcessEnv)).toThrow(
      "GITHUB_EVENT_PATH",
    );
    expect(() =>
      parseConfig({ GITHUB_REPOSITORY: "o/r", MODE: "release" } as NodeJS.ProcessEnv),
    ).toThrow("GITHUB_SHA");
    expect(() => parseConfig({ MODE: "release" } as NodeJS.ProcessEnv)).toThrow(
      "GITHUB_REPOSITORY",
    );
  });

  test("rejects an unknown severity", () => {
    expect(() =>
      parseConfig({
        ...baseEnv,
        MODE: "release",
        SECURITY_SEVERITY: "severe",
      } as NodeJS.ProcessEnv),
    ).toThrow("SECURITY_SEVERITY");
  });

  test("rejects flag-like and oversized labels", () => {
    for (const label of ["-x", "--help", "a\nb", "x".repeat(51)]) {
      expect(() =>
        parseConfig({ ...baseEnv, MODE: "release", BLOCKER_LABEL: label } as NodeJS.ProcessEnv),
      ).toThrow("BLOCKER_LABEL");
      expect(() =>
        parseConfig({ ...baseEnv, MODE: "release", TRACKING_LABELS: label } as NodeJS.ProcessEnv),
      ).toThrow("TRACKING_LABELS");
      expect(() =>
        parseConfig({ ...baseEnv, MODE: "release", FUZZ_LABEL: label } as NodeJS.ProcessEnv),
      ).toThrow("FUZZ_LABEL");
    }
  });

  test("LABEL_RE matches the shape the fuzz-issue action enforces", () => {
    expect(LABEL_RE.test("fuzz-nightly")).toBe(true);
    expect(LABEL_RE.test("autorelease: pending")).toBe(true);
    expect(LABEL_RE.test("-x")).toBe(false);
  });
});

describe("parseTrackingLabels", () => {
  test("empty environment means no tracking labels", () => {
    expect(parseTrackingLabels({} as NodeJS.ProcessEnv)).toEqual({
      labels: [],
      legacyFuzzLabel: undefined,
    });
    expect(parseTrackingLabels({ TRACKING_LABELS: "" } as NodeJS.ProcessEnv)).toEqual({
      labels: [],
      legacyFuzzLabel: undefined,
    });
  });

  test("splits on commas, trimming whitespace and dropping empty tokens; one label needs no comma", () => {
    expect(
      parseTrackingLabels({
        TRACKING_LABELS: " fuzz-nightly , nightly-failure ,",
      } as NodeJS.ProcessEnv),
    ).toEqual({ labels: ["fuzz-nightly", "nightly-failure"], legacyFuzzLabel: undefined });
    expect(parseTrackingLabels({ TRACKING_LABELS: "fuzz-nightly" } as NodeJS.ProcessEnv)).toEqual({
      labels: ["fuzz-nightly"],
      legacyFuzzLabel: undefined,
    });
  });

  test("a label sourced from the deprecated FUZZ_LABEL alone is flagged legacy", () => {
    expect(parseTrackingLabels({ FUZZ_LABEL: "fuzz-nightly" } as NodeJS.ProcessEnv)).toEqual({
      labels: ["fuzz-nightly"],
      legacyFuzzLabel: "fuzz-nightly",
    });
  });

  test("FUZZ_LABEL already covered by TRACKING_LABELS is deduplicated, not legacy", () => {
    // Case-insensitively, the way GitHub deduplicates label names.
    expect(
      parseTrackingLabels({
        TRACKING_LABELS: "Fuzz-Nightly,nightly-failure",
        FUZZ_LABEL: "fuzz-nightly",
      } as NodeJS.ProcessEnv),
    ).toEqual({ labels: ["Fuzz-Nightly", "nightly-failure"], legacyFuzzLabel: undefined });
  });
});

describe("severitiesAtOrAbove", () => {
  test("covers each boundary", () => {
    expect(severitiesAtOrAbove("low")).toEqual(["low", "medium", "high", "critical"]);
    expect(severitiesAtOrAbove("medium")).toEqual(["medium", "high", "critical"]);
    expect(severitiesAtOrAbove("high")).toEqual(["high", "critical"]);
    expect(severitiesAtOrAbove("critical")).toEqual(["critical"]);
  });
});

describe("issueGate", () => {
  const overLimit = Array.from({ length: 120 }, (_, i) => i + 1);
  const cases: Array<{ reason: string; open: number[]; expected: GateOutcome }> = [
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
  ];
  test.each(cases)("$reason", async ({ open, expected }) => {
    const { run, calls } = fakeGh({ issues: { "release-blocker": open } });
    const outcome = await issueGate(run, REPO, "blocker", "release-blocker", "close them");
    expect(outcome).toEqual(expected);
    // One fixed command, naming the repo explicitly (no checkout to infer it
    // from) and capped at gh's list limit.
    expect(calls).toEqual([issueListCall("release-blocker")]);
  });
});

describe("securityGate", () => {
  test.each([
    ["high", "repos/o/r/dependabot/alerts?state=open&severity=high,critical&per_page=100"],
    ["critical", "repos/o/r/dependabot/alerts?state=open&severity=critical&per_page=100"],
  ] as const)(
    "passes when no alert at or above %s is open, querying only those severities",
    async (threshold, url) => {
      const { run, calls } = fakeGh({ alerts: [] });
      const outcome = await securityGate(run, "o/r", threshold, "advice");
      expect(outcome).toEqual({
        gate: "security",
        status: "pass",
        summary: `no open Dependabot alerts at or above ${threshold}`,
      });
      expect(calls).toEqual([["api", url]]);
    },
  );

  test("fails naming the open alerts", async () => {
    const { run } = fakeGh({ alerts: [1, 2, 3] });
    expect(await securityGate(run, "o/r", "medium", "fix them")).toEqual({
      gate: "security",
      status: "fail",
      problem: "3 open Dependabot alert(s) at or above medium: #1, #2, #3",
      advice: "fix them",
    });
  });

  test.each([
    [
      "a bare 403 (missing vulnerability-alerts grant)",
      "gh api failed (1): HTTP 403: Resource not accessible by integration",
    ],
    [
      "Dependabot alerts disabled on the repository",
      "gh api failed (1): Dependabot alerts are disabled for this repository. (HTTP 403)",
    ],
    ["a host without the feature (404)", "gh api failed (1): Not Found (HTTP 404)"],
  ])("degrades to a skip on %s", async (_reason, message) => {
    const { run } = fakeGh({ alertsError: message });
    expect(await securityGate(run, "o/r", "high", "advice")).toEqual({
      gate: "security",
      status: "skip",
      reason: message,
    });
  });

  test("an unexpected error propagates instead of skipping", async () => {
    const { run } = fakeGh({ alertsError: "gh api failed (1): HTTP 500: boom" });
    expect(securityGate(run, "o/r", "high", "advice")).rejects.toThrow("HTTP 500");
  });

  test("a rate-limited 403 propagates instead of skipping the gate", async () => {
    for (const message of [
      "gh api failed (1): API rate limit exceeded for installation ID 1 (HTTP 403)",
      "gh api failed (1): You have exceeded a secondary rate limit. (HTTP 403)",
      "gh api failed (1): You have triggered an abuse detection mechanism. (HTTP 403)",
    ]) {
      const { run } = fakeGh({ alertsError: message });
      expect(securityGate(run, "o/r", "high", "advice")).rejects.toThrow("HTTP 403");
    }
  });
});

describe("overrideFromPullRequest", () => {
  test.each([
    ["exact spelling", ["release-override"]],
    ["case-insensitively, the way GitHub deduplicates labels", ["Release-Override"]],
  ])(
    "finds the label (%s) via a live gh pr view naming the repo",
    async (_reason, prViewLabels) => {
      const { run, calls } = fakeGh({ prViewLabels });
      const override = await overrideFromPullRequest(run, REPO, eventPath, "release-override");
      expect(override).toEqual({ active: true, prNumber: 12 });
      expect(calls).toEqual([PR_VIEW_CALL]);
    },
  );

  test("a failed live lookup propagates instead of trusting the payload snapshot", async () => {
    // The payload names the override label, but the gate must fail closed:
    // the snapshot could equally be missing a label added for a re-run or
    // carrying one that was since removed.
    const path = join(eventDir, "labeled.json");
    writeFileSync(
      path,
      JSON.stringify({ pull_request: { number: 8, labels: [{ name: "release-override" }] } }),
    );
    const { run } = fakeGh({});
    expect(overrideFromPullRequest(run, REPO, path, "release-override")).rejects.toThrow(
      "gh pr view failed",
    );
  });

  test("malformed pr view JSON propagates as an error", async () => {
    const run: GhRunner = async () => "not json";
    expect(overrideFromPullRequest(run, REPO, eventPath, "release-override")).rejects.toThrow();
  });

  test("no label on the live PR means no override, naming the PR", async () => {
    const { run } = fakeGh({ prViewLabels: ["autorelease: pending"] });
    const override = await overrideFromPullRequest(run, REPO, eventPath, "release-override");
    expect(override).toEqual({ active: false, reason: "no 'release-override' label on PR #12" });
  });

  test("a missing payload or one without a pull_request means no override, without a gh call", async () => {
    const { run, calls } = fakeGh({});
    const missing = join(eventDir, "missing.json");
    expect(await overrideFromPullRequest(run, REPO, missing, "x")).toEqual({
      active: false,
      reason: `no event payload at ${missing}`,
    });
    const path = join(eventDir, "push.json");
    writeFileSync(path, JSON.stringify({ ref: "refs/heads/main" }));
    expect(await overrideFromPullRequest(run, REPO, path, "x")).toEqual({
      active: false,
      reason: "event payload carries no pull_request",
    });
    expect(calls).toEqual([]);
  });
});

describe("findReleasePr", () => {
  test("finds the merged PR whose head ref is a release-please branch", async () => {
    const { run, calls } = fakeGh({
      commitPulls: [
        { number: 3, head: { ref: "feature/x" }, labels: [] },
        {
          number: 5,
          head: { ref: "release-please--branches--main" },
          labels: [{ name: "l" }],
          merged_at: "2026-08-09T00:00:00Z",
        },
      ],
    });
    const lookup = await findReleasePr(run, REPO, "abc123");
    expect(lookup).toEqual({ pr: { number: 5, labels: ["l"] }, unmerged: [] });
    expect(calls).toEqual([COMMIT_PULLS_CALL]);
  });

  test("a release PR on a later page is still found (slurped pages are flattened)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 100,
      head: { ref: `fix/${i}` },
      labels: [],
    }));
    const page2 = [
      {
        number: 5,
        head: { ref: "release-please--branches--main" },
        labels: [{ name: "l" }],
        merged_at: "2026-08-09T00:00:00Z",
      },
    ];
    const run: GhRunner = async () => JSON.stringify([page1, page2]);
    expect(await findReleasePr(run, REPO, "abc123")).toEqual({
      pr: { number: 5, labels: ["l"] },
      unmerged: [],
    });
  });

  test("no associated release PR means no merge and nothing unmerged", async () => {
    const { run } = fakeGh({ commitPulls: [{ number: 3, head: { ref: "fix/y" }, labels: [] }] });
    expect(await findReleasePr(run, REPO, "abc123")).toEqual({ pr: undefined, unmerged: [] });
  });

  test("a single UNMERGED release-please candidate is not a merge", async () => {
    // An open release PR associated with a pushed commit must not have its
    // labels consulted; only an actual merge is gated.
    const { run } = fakeGh({
      commitPulls: [
        {
          number: 8,
          head: { ref: "release-please--branches--main" },
          labels: [{ name: "release-override" }],
          merged_at: null,
        },
      ],
    });
    expect(await findReleasePr(run, REPO, "abc123")).toEqual({ pr: undefined, unmerged: [8] });
  });

  test("with several release-please PRs, only the merged one wins", async () => {
    const { run } = fakeGh({
      commitPulls: [
        {
          number: 4,
          head: { ref: "release-please--branches--next" },
          labels: [],
          merged_at: null,
        },
        {
          number: 6,
          head: { ref: "release-please--branches--main" },
          labels: [{ name: "l" }],
          merged_at: "2026-08-09T00:00:00Z",
        },
      ],
    });
    expect(await findReleasePr(run, REPO, "abc123")).toEqual({
      pr: { number: 6, labels: ["l"] },
      unmerged: [4],
    });
  });

  test("more than one MERGED release-please PR fails closed naming the numbers", async () => {
    const { run } = fakeGh({
      commitPulls: [
        {
          number: 4,
          head: { ref: "release-please--branches--next" },
          labels: [],
          merged_at: "2026-08-08T00:00:00Z",
        },
        {
          number: 6,
          head: { ref: "release-please--branches--main" },
          labels: [],
          merged_at: "2026-08-09T00:00:00Z",
        },
      ],
    });
    expect(findReleasePr(run, REPO, "abc123")).rejects.toThrow("#4, #6");
  });

  test("malformed commit-pulls JSON propagates as an error", async () => {
    const run: GhRunner = async () => "not json";
    expect(findReleasePr(run, REPO, "abc123")).rejects.toThrow();
  });
});

describe("runHealthCheck", () => {
  function collect(): { out: (line: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { out: (line) => lines.push(line), lines };
  }

  // The advice each gate family attaches to its ::error line, pinned
  // verbatim: it is the operator's only instruction when a release is blocked.
  const OVERRIDE_HINT =
    "or apply the 'release-override' label to the release PR and re-run this check";
  const TRACKING_ADVICE = `fix the failures behind it (the stream's next green nightly run closes the tracking issue automatically), ${OVERRIDE_HINT}`;
  const BLOCKER_ADVICE = `close the blocker issue(s), ${OVERRIDE_HINT}`;
  const SECURITY_ADVICE = `fix or dismiss the alert(s) under the repository's Security tab, ${OVERRIDE_HINT}`;

  test("all gates green is a one-line success", async () => {
    const { run } = fakeGh({ issues: {}, alerts: [], prViewLabels: [] });
    const { out, lines } = collect();
    expect(await runHealthCheck(prConfig(), run, out)).toBe(0);
    expect(lines).toEqual([
      "release health: all gates passed (tracking:fuzz-nightly: no open 'fuzz-nightly' issues; blocker: no open 'release-blocker' issues; security: no open Dependabot alerts at or above high)",
    ]);
  });

  test("an empty tracking-label list runs no tracking gate", async () => {
    const { run, calls } = fakeGh({ issues: {}, alerts: [], prViewLabels: [] });
    const { out } = collect();
    expect(await runHealthCheck(prConfig({ trackingLabels: [] }), run, out)).toBe(0);
    const issueLists = calls.filter((c) => c[0] === "issue");
    expect(issueLists).toHaveLength(1);
    expect(issueLists[0]?.[issueLists[0].indexOf("--label") + 1]).toBe("release-blocker");
  });

  test("a legacy-sourced label draws a deprecation notice and still gates", async () => {
    const { run } = fakeGh({
      issues: { "fuzz-nightly": [2], "release-blocker": [] },
      alerts: [],
      prViewLabels: [],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(prConfig({ legacyFuzzLabel: "fuzz-nightly" }), run, out)).toBe(1);
    expect(lines).toEqual([
      "::notice::tracking label 'fuzz-nightly' arrived via the deprecated fuzz-label input; this workflow render predates the tracking-labels input, and the next template sync moves the label there",
      `::error::tracking:fuzz-nightly gate failed: 1 open 'fuzz-nightly' issue(s): #2. To release: ${TRACKING_ADVICE}`,
    ]);
  });

  test("each tracking label is its own gate, queried and reported by label", async () => {
    const { run, calls } = fakeGh({
      issues: { "fuzz-nightly": [], "nightly-failure": [3], "release-blocker": [] },
      alerts: [],
      prViewLabels: [],
    });
    const { out, lines } = collect();
    const cfg = prConfig({ trackingLabels: ["fuzz-nightly", "nightly-failure"] });
    expect(await runHealthCheck(cfg, run, out)).toBe(1);
    const queried = calls.filter((c) => c[0] === "issue").map((c) => c[c.indexOf("--label") + 1]);
    expect(queried).toEqual(["fuzz-nightly", "nightly-failure", "release-blocker"]);
    expect(lines).toEqual([
      `::error::tracking:nightly-failure gate failed: 1 open 'nightly-failure' issue(s): #3. To release: ${TRACKING_ADVICE}`,
    ]);
  });

  test("security off runs no security gate", async () => {
    const { run, calls } = fakeGh({ issues: {}, prViewLabels: [] });
    const { out } = collect();
    expect(await runHealthCheck(prConfig({ security: "off" }), run, out)).toBe(0);
    expect(calls.some((c) => c[1]?.includes("/dependabot/"))).toBe(false);
  });

  test("each failing gate is an ::error with its advice, exit 1", async () => {
    const { run } = fakeGh({
      issues: { "fuzz-nightly": [2], "release-blocker": [7] },
      alerts: [11],
      prViewLabels: [],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(prConfig(), run, out)).toBe(1);
    expect(lines).toEqual([
      `::error::tracking:fuzz-nightly gate failed: 1 open 'fuzz-nightly' issue(s): #2. To release: ${TRACKING_ADVICE}`,
      `::error::blocker gate failed: 1 open 'release-blocker' issue(s): #7. To release: ${BLOCKER_ADVICE}`,
      `::error::security gate failed: 1 open Dependabot alert(s) at or above high: #11. To release: ${SECURITY_ADVICE}`,
    ]);
  });

  test("the override on the PR turns failures into warnings plus a loud notice, exit 0, with every gate still run", async () => {
    const { run, calls } = fakeGh({
      issues: { "fuzz-nightly": [], "release-blocker": [7] },
      alerts: [5],
      prViewLabels: ["release-override"],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(prConfig(), run, out)).toBe(0);
    // Every gate is queried even though the override makes the result moot,
    // so the report is complete.
    expect(calls).toEqual([
      PR_VIEW_CALL,
      issueListCall("fuzz-nightly"),
      issueListCall("release-blocker"),
      ALERTS_HIGH_CALL,
    ]);
    expect(lines).toEqual([
      "::warning::blocker gate failed: 1 open 'release-blocker' issue(s): #7",
      "::warning::security gate failed: 1 open Dependabot alert(s) at or above high: #5",
      "::notice::OVERRIDE: the 'release-override' label on release PR #12 bypassed 2 failing gate(s) (blocker, security); this release ships despite them",
    ]);
  });

  test("release mode: the override is read from the commit's merged release PR", async () => {
    const { run } = fakeGh({
      issues: { "fuzz-nightly": [], "release-blocker": [7] },
      alerts: [],
      commitPulls: [
        {
          number: 21,
          head: { ref: "release-please--branches--main" },
          labels: [{ name: "release-override" }],
          merged_at: "2026-08-09T00:00:00Z",
        },
      ],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(releaseConfig(), run, out)).toBe(0);
    expect(lines).toEqual([
      "::warning::blocker gate failed: 1 open 'release-blocker' issue(s): #7",
      "::notice::OVERRIDE: the 'release-override' label on release PR #21 bypassed 1 failing gate(s) (blocker); this release ships despite them",
    ]);
  });

  test("release mode: a release-PR merge with a red gate and no override fails", async () => {
    const { run, calls } = fakeGh({
      issues: { "fuzz-nightly": [], "release-blocker": [7] },
      alerts: [],
      commitPulls: [
        {
          number: 21,
          head: { ref: "release-please--branches--main" },
          labels: [],
          merged_at: "2026-08-09T00:00:00Z",
        },
      ],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(releaseConfig(), run, out)).toBe(1);
    expect(calls).toEqual([
      COMMIT_PULLS_CALL,
      issueListCall("fuzz-nightly"),
      issueListCall("release-blocker"),
      ALERTS_HIGH_CALL,
    ]);
    expect(lines).toEqual([
      `::error::blocker gate failed: 1 open 'release-blocker' issue(s): #7. To release: ${BLOCKER_ADVICE}`,
    ]);
  });

  test("release mode: a push that is not a release-PR merge is not gated at all", async () => {
    // Release-please runs on every main push but only cuts a release from a
    // release-PR merge; an open blocker must not paint ordinary pushes red.
    const { run, calls } = fakeGh({
      issues: { "release-blocker": [7] },
      commitPulls: [{ number: 3, head: { ref: "feature/x" }, labels: [] }],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(releaseConfig(), run, out)).toBe(0);
    expect(lines).toEqual([
      "::notice::release health: abc123 is not a release-PR merge; nothing to gate",
    ]);
    // No gate was queried: the lookup is the only gh call.
    expect(calls).toEqual([COMMIT_PULLS_CALL]);
  });

  test("release mode: a single UNMERGED release PR is the trivial pass, naming it", async () => {
    // Its labels (even the override) must not be consulted: only a merge is
    // gated, and an open release PR rides along with ordinary pushes.
    const { run, calls } = fakeGh({
      issues: { "release-blocker": [7] },
      commitPulls: [
        {
          number: 9,
          head: { ref: "release-please--branches--main" },
          labels: [{ name: "release-override" }],
          merged_at: null,
        },
      ],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(releaseConfig(), run, out)).toBe(0);
    expect(lines).toEqual([
      "::notice::release health: abc123 is not a release-PR merge; nothing to gate (open release PR(s) associated: #9)",
    ]);
    expect(calls).toEqual([COMMIT_PULLS_CALL]);
  });

  test("a 403 on the alerts endpoint is a notice, not a block", async () => {
    const { run } = fakeGh({
      issues: {},
      alertsError: "gh api failed (1): HTTP 403: Resource not accessible by integration",
      prViewLabels: [],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(prConfig(), run, out)).toBe(0);
    expect(lines).toEqual([
      "::notice::security gate skipped: gh api failed (1): HTTP 403: Resource not accessible by integration",
      "release health: all gates passed (tracking:fuzz-nightly: no open 'fuzz-nightly' issues; blocker: no open 'release-blocker' issues; security: skipped)",
    ]);
  });

  test("a failed override lookup errors the run instead of gating blind", async () => {
    const { run } = fakeGh({ issues: {}, alerts: [], prViewLabels: undefined });
    const { out } = collect();
    expect(runHealthCheck(prConfig(), run, out)).rejects.toThrow("gh pr view failed");
  });
});
