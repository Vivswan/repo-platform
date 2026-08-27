/**
 * Unit tests for the release-health action: config parsing, each gate, the
 * override resolution in both modes, and the end-to-end outcome through an
 * injected fake gh runner. The real gh calls are not tested here (they need
 * a live GitHub).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  findReleasePr,
  type GhRunner,
  issueGate,
  LABEL_RE,
  overrideFromPullRequest,
  parseConfig,
  parseTrackingLabels,
  runHealthCheck,
  SEVERITIES,
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

let eventDir: string;
let eventPath: string;

beforeAll(() => {
  eventDir = mkdtempSync(join(tmpdir(), "release-health-"));
  eventPath = join(eventDir, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { number: 12, labels: [{ name: "autorelease: pending" }] } }),
  );
});

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

describe("parseConfig", () => {
  test("parses pull-request mode with defaults", () => {
    const cfg = parseConfig({
      ...baseEnv,
      MODE: "pull-request",
      GITHUB_EVENT_PATH: eventPath,
    } as NodeJS.ProcessEnv);
    expect(cfg.context).toEqual({ mode: "pull-request", eventPath });
    expect(cfg.trackingLabels).toEqual([]);
    expect(cfg.blockerLabel).toBe("release-blocker");
    expect(cfg.overrideLabel).toBe("release-override");
    expect(cfg.security).toBe("high");
  });

  test("parses release mode with explicit values", () => {
    const cfg = parseConfig({
      ...baseEnv,
      MODE: "release",
      TRACKING_LABELS: "fuzz-nightly,nightly-failure",
      BLOCKER_LABEL: "no-ship",
      OVERRIDE_LABEL: "ship-anyway",
      SECURITY_SEVERITY: "critical",
    } as NodeJS.ProcessEnv);
    expect(cfg.context).toEqual({ mode: "release", sha: "abc123" });
    expect(cfg.trackingLabels).toEqual(["fuzz-nightly", "nightly-failure"]);
    expect(cfg.blockerLabel).toBe("no-ship");
    expect(cfg.overrideLabel).toBe("ship-anyway");
    expect(cfg.security).toBe("critical");
  });

  test("accepts off as the security threshold", () => {
    const cfg = parseConfig({
      ...baseEnv,
      MODE: "release",
      SECURITY_SEVERITY: "off",
    } as NodeJS.ProcessEnv);
    expect(cfg.security).toBe("off");
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

  test("splits on commas, trimming whitespace and dropping empty tokens", () => {
    expect(
      parseTrackingLabels({
        TRACKING_LABELS: " fuzz-nightly , nightly-failure ,",
      } as NodeJS.ProcessEnv).labels,
    ).toEqual(["fuzz-nightly", "nightly-failure"]);
  });

  test("a single label needs no comma", () => {
    expect(
      parseTrackingLabels({ TRACKING_LABELS: "fuzz-nightly" } as NodeJS.ProcessEnv).labels,
    ).toEqual(["fuzz-nightly"]);
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

  test("stays exhaustive over the severity list", () => {
    expect(SEVERITIES.flatMap((s) => severitiesAtOrAbove(s)).length).toBe(4 + 3 + 2 + 1);
  });
});

describe("issueGate", () => {
  test("passes when no open issue carries the label, naming the repo explicitly", async () => {
    const { run, calls } = fakeGh({ issues: {} });
    const outcome = await issueGate(run, REPO, "blocker", "release-blocker", "advice");
    expect(outcome.status).toBe("pass");
    const list = calls[0];
    expect(list?.[list.indexOf("--repo") + 1]).toBe(REPO);
    expect(list?.[list.indexOf("--label") + 1]).toBe("release-blocker");
    expect(list?.[list.indexOf("--state") + 1]).toBe("open");
  });

  test("fails naming every open issue", async () => {
    const { run } = fakeGh({ issues: { "release-blocker": [4, 9] } });
    const outcome = await issueGate(run, REPO, "blocker", "release-blocker", "close them");
    expect(outcome.status).toBe("fail");
    if (outcome.status === "fail") {
      expect(outcome.problem).toContain("2 open 'release-blocker' issue(s): #4, #9");
      expect(outcome.advice).toBe("close them");
    }
  });

  test("a count at gh's list limit is reported as at least, never understated", async () => {
    const open = Array.from({ length: 120 }, (_, i) => i + 1);
    const { run, calls } = fakeGh({ issues: { "release-blocker": open } });
    const outcome = await issueGate(run, REPO, "blocker", "release-blocker", "advice");
    expect(calls[0]?.[calls[0].indexOf("--limit") + 1]).toBe("100");
    expect(outcome.status).toBe("fail");
    if (outcome.status === "fail") {
      expect(outcome.problem).toContain("at least 100 open 'release-blocker' issue(s)");
    }
  });
});

describe("securityGate", () => {
  test("passes when no alert at or above the threshold is open", async () => {
    const { run, calls } = fakeGh({ alerts: [] });
    const outcome = await securityGate(run, "o/r", "high", "advice");
    expect(outcome.status).toBe("pass");
    expect(calls[0]?.[1]).toBe(
      "repos/o/r/dependabot/alerts?state=open&severity=high,critical&per_page=100",
    );
  });

  test("queries only the severities at or above the threshold", async () => {
    const { run, calls } = fakeGh({ alerts: [] });
    await securityGate(run, "o/r", "critical", "advice");
    expect(calls[0]?.[1]).toContain("severity=critical&");
    expect(calls[0]?.[1]).not.toContain("high");
  });

  test("fails naming the open alerts", async () => {
    const { run } = fakeGh({ alerts: [1, 2, 3] });
    const outcome = await securityGate(run, "o/r", "medium", "fix them");
    expect(outcome.status).toBe("fail");
    if (outcome.status === "fail") {
      expect(outcome.problem).toContain(
        "3 open Dependabot alert(s) at or above medium: #1, #2, #3",
      );
    }
  });

  test("degrades to a skip on HTTP 403 (missing vulnerability-alerts grant)", async () => {
    const { run } = fakeGh({
      alertsError: "gh api failed (1): HTTP 403: Resource not accessible by integration",
    });
    const outcome = await securityGate(run, "o/r", "high", "advice");
    expect(outcome.status).toBe("skip");
  });

  test("degrades to a skip when Dependabot alerts are disabled or the endpoint 404s", async () => {
    for (const message of [
      "gh api failed (1): Dependabot alerts are disabled for this repository. (HTTP 403)",
      "gh api failed (1): Not Found (HTTP 404)",
    ]) {
      const { run } = fakeGh({ alertsError: message });
      const outcome = await securityGate(run, "o/r", "high", "advice");
      expect(outcome.status).toBe("skip");
      if (outcome.status === "skip") {
        expect(outcome.reason).toBe(message);
      }
    }
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
  test("finds the label via a live gh pr view naming the repo", async () => {
    const { run, calls } = fakeGh({ prViewLabels: ["release-override"] });
    const override = await overrideFromPullRequest(run, REPO, eventPath, "release-override");
    expect(override).toEqual({ active: true, prNumber: 12 });
    expect(calls[0]?.slice(0, 3)).toEqual(["pr", "view", "12"]);
    expect(calls[0]?.[calls[0].indexOf("--repo") + 1]).toBe(REPO);
  });

  test("label comparison is case-insensitive, the way GitHub deduplicates", async () => {
    const { run } = fakeGh({ prViewLabels: ["Release-Override"] });
    const override = await overrideFromPullRequest(run, REPO, eventPath, "release-override");
    expect(override.active).toBe(true);
  });

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

  test("a missing payload or one without a pull_request means no override", async () => {
    const { run } = fakeGh({});
    expect((await overrideFromPullRequest(run, REPO, "/nonexistent", "x")).active).toBe(false);
    const path = join(eventDir, "push.json");
    writeFileSync(path, JSON.stringify({ ref: "refs/heads/main" }));
    expect((await overrideFromPullRequest(run, REPO, path, "x")).active).toBe(false);
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
    expect(calls[0]?.slice(1)).toEqual([
      "--paginate",
      "--slurp",
      "repos/o/r/commits/abc123/pulls?per_page=100",
    ]);
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
    const lookup = await findReleasePr(run, REPO, "abc123");
    expect(lookup.pr).toEqual({ number: 5, labels: ["l"] });
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

  test("all gates green is a one-line success", async () => {
    const { run } = fakeGh({ issues: {}, alerts: [], prViewLabels: [] });
    const { out, lines } = collect();
    expect(await runHealthCheck(prConfig(), run, out)).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("all gates passed");
    expect(lines[0]).toContain("tracking:fuzz-nightly");
    expect(lines[0]).toContain("blocker");
    expect(lines[0]).toContain("Dependabot");
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
    const notice = lines.find((line) => line.startsWith("::notice::"));
    expect(notice).toContain("deprecated fuzz-label input");
    expect(notice).toContain("tracking-labels");
    expect(
      lines.some((line) => line.startsWith("::error::tracking:fuzz-nightly gate failed")),
    ).toBe(true);
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
    const errors = lines.filter((line) => line.startsWith("::error::"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tracking:nightly-failure gate failed");
    expect(errors[0]).toContain("1 open 'nightly-failure' issue(s): #3");
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
    const errors = lines.filter((line) => line.startsWith("::error::"));
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("tracking:fuzz-nightly gate failed");
    expect(errors[0]).toContain("green nightly run closes the tracking issue");
    expect(errors[1]).toContain("blocker gate failed");
    expect(errors[1]).toContain("close the blocker issue(s)");
    expect(errors[2]).toContain("security gate failed");
    expect(errors[2]).toContain("fix or dismiss");
    for (const error of errors) {
      expect(error).toContain("apply the 'release-override' label");
    }
  });

  test("the override on the PR turns failures into warnings plus a loud notice, exit 0", async () => {
    const { run } = fakeGh({
      issues: { "fuzz-nightly": [], "release-blocker": [7] },
      alerts: [],
      prViewLabels: ["release-override"],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(prConfig(), run, out)).toBe(0);
    expect(lines.filter((line) => line.startsWith("::warning::"))).toHaveLength(1);
    expect(lines[0]).toContain("blocker gate failed");
    const notice = lines.find((line) => line.startsWith("::notice::"));
    expect(notice).toContain("OVERRIDE");
    expect(notice).toContain("release PR #12");
    expect(notice).toContain("1 failing gate(s) (blocker)");
    expect(lines.some((line) => line.startsWith("::error::"))).toBe(false);
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
    const notice = lines.find((line) => line.includes("OVERRIDE"));
    expect(notice).toContain("release PR #21");
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
    expect(lines.some((line) => line.startsWith("::error::blocker gate failed"))).toBe(true);
    expect(calls.some((c) => c[0] === "issue")).toBe(true);
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
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("::notice::");
    expect(lines[0]).toContain("not a release-PR merge; nothing to gate");
    expect(calls.some((c) => c[0] === "issue")).toBe(false);
    expect(calls.some((c) => c[1]?.includes("/dependabot/"))).toBe(false);
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
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not a release-PR merge; nothing to gate");
    expect(lines[0]).toContain("open release PR(s) associated: #9");
    expect(calls.some((c) => c[0] === "issue")).toBe(false);
    expect(calls.some((c) => c[1]?.includes("/dependabot/"))).toBe(false);
  });

  test("a 403 on the alerts endpoint is a notice, not a block", async () => {
    const { run } = fakeGh({
      issues: {},
      alertsError: "gh api failed (1): HTTP 403: Resource not accessible by integration",
      prViewLabels: [],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(prConfig(), run, out)).toBe(0);
    const notice = lines.find((line) => line.startsWith("::notice::security gate skipped:"));
    expect(notice).toContain("HTTP 403");
    expect(lines.some((line) => line.startsWith("::error::"))).toBe(false);
  });

  test("gates run and are reported even when the override is active", async () => {
    const { run, calls } = fakeGh({
      issues: { "fuzz-nightly": [2], "release-blocker": [] },
      alerts: [5],
      prViewLabels: ["release-override"],
    });
    const { out, lines } = collect();
    expect(await runHealthCheck(prConfig(), run, out)).toBe(0);
    expect(calls.filter((c) => c[0] === "issue")).toHaveLength(2);
    expect(calls.some((c) => c[1]?.includes("/dependabot/"))).toBe(true);
    expect(lines.filter((line) => line.startsWith("::warning::"))).toHaveLength(2);
  });

  test("a failed override lookup errors the run instead of gating blind", async () => {
    const { run } = fakeGh({ issues: {}, alerts: [], prViewLabels: undefined });
    const { out } = collect();
    expect(runHealthCheck(prConfig(), run, out)).rejects.toThrow("gh pr view failed");
  });
});
