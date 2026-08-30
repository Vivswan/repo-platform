// Unit tests for the scheduled heal's green-commit walk: the bounded
// first-parent search behind a red tip, with every candidate vouched by
// the same all-green predicate the tip faced. The gh runner (serving both
// the commits listing and the per-sha verdict probes), the clock, and the
// bounds are injected so nothing here touches the network or sleeps.
//
// Three of these are FORCING tests for scripts/guard_registry.ts entries
// (walk-commit-bound, walk-age-bound, walk-vouches-candidates): the
// weekly arming audit mutates the guard and requires the named test red,
// so their fixtures deliberately stage the exact attack each bound stops.

import { describe, expect, test } from "bun:test";
import { newestGreenCommit } from "../../.github/scripts/fleet/newest_green_commit";
import type { GhRunner } from "../../.github/scripts/shared/all_green.ts";

/** A readable 40-hex sha from one hex character. */
const sha = (c: string) => c.repeat(40);

/** The walk's injected clock, and the default (fresh) commit date. */
const NOW = Date.parse("2026-08-29T00:00:00Z");
const FRESH = "2026-08-28T00:00:00Z";
const DAY_MS = 24 * 60 * 60 * 1000;

interface FixtureCommit {
  sha: string;
  /** First parent; extras model a merge commit's side parents. */
  parents?: string[];
  /** ISO committer date; null models a dateless commit; default fresh. */
  date?: string | null;
  /** The sha's all-green state: green/red verdicts, none (no check run
   *  at all), error (the probe itself fails). Default red. */
  verdict?: "green" | "red" | "none" | "error";
}

/** One runner answering BOTH api shapes the walk issues, keyed on the
 *  request path, so a fixture is just the commit graph plus verdicts. */
function ghFor(commits: FixtureCommit[], listingExit = 0): GhRunner {
  return (command) => {
    const path = command[2] ?? "";
    const probed = /commits\/([0-9a-f]{40})\/check-runs/.exec(path);
    if (probed !== null) {
      const commit = commits.find((entry) => entry.sha === probed[1]);
      const verdict = commit?.verdict ?? "red";
      if (verdict === "error") return { exitCode: 1, stdout: "", stderr: "probe boom" };
      const runs =
        verdict === "none"
          ? []
          : [
              {
                name: "all-green",
                status: "completed",
                conclusion: verdict === "green" ? "success" : "failure",
                external_id: "push",
                app: { slug: "github-actions" },
              },
            ];
      return { exitCode: 0, stdout: JSON.stringify({ check_runs: runs }), stderr: "" };
    }
    if (listingExit !== 0) return { exitCode: listingExit, stdout: "", stderr: "listing boom" };
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        commits.map((entry) => ({
          sha: entry.sha,
          commit: {
            committer: entry.date === null ? null : { date: entry.date ?? FRESH },
          },
          parents: (entry.parents ?? []).map((parent) => ({ sha: parent })),
        })),
      ),
      stderr: "",
    };
  };
}

function walk(
  commits: FixtureCommit[],
  options: { maxCommits?: number; maxAgeMs?: number; listingExit?: number } = {},
) {
  const settings: Parameters<typeof newestGreenCommit>[2] = {
    gh: ghFor(commits, options.listingExit ?? 0),
    now: NOW,
    log: () => {},
  };
  if (options.maxCommits !== undefined) settings.maxCommits = options.maxCommits;
  if (options.maxAgeMs !== undefined) settings.maxAgeMs = options.maxAgeMs;
  return newestGreenCommit("o/r", sha("a"), settings);
}

describe("newestGreenCommit", () => {
  test("the newest green ancestor directly behind a red tip is chosen", () => {
    const outcome = walk([
      { sha: sha("a"), parents: [sha("b")], verdict: "red" },
      { sha: sha("b"), parents: [sha("c")], verdict: "green" },
      { sha: sha("c"), verdict: "green" },
    ]);
    expect(outcome).toEqual({ sha: sha("b"), behind: 1 });
  });

  test("a red ancestor is never chosen: the walk vouches each candidate and picks the green one behind it", () => {
    // The walk-vouches-candidates forcing fixture: with the per-candidate
    // allGreenFailure probe unarmed, the walk would return the RED first
    // ancestor - the exact unvouched write the property forbids.
    const outcome = walk([
      { sha: sha("a"), parents: [sha("b")], verdict: "red" },
      { sha: sha("b"), parents: [sha("c")], verdict: "red" },
      { sha: sha("c"), verdict: "green" },
    ]);
    expect(outcome).toEqual({ sha: sha("c"), behind: 2 });
  });

  test("a green commit beyond the walk's commit bound is NOT vouched - the heal refuses", () => {
    // The walk-commit-bound forcing fixture: the only green commit sits
    // one past the bound, so an unarmed bound would find and return it.
    const outcome = walk(
      [
        { sha: sha("a"), parents: [sha("b")], verdict: "red" },
        { sha: sha("b"), parents: [sha("c")], verdict: "red" },
        { sha: sha("c"), parents: [sha("d")], verdict: "red" },
        { sha: sha("d"), verdict: "green" },
      ],
      { maxCommits: 2 },
    );
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("no green commit within 2 commits");
    }
  });

  test("a green commit older than the walk's age bound is NOT vouched - the heal refuses", () => {
    // The walk-age-bound forcing fixture: a green ancestor 20 days old
    // under the default 14-day bound - an unarmed bound would apply it,
    // rolling the fleet's settings back three weeks without a human.
    const stale = new Date(NOW - 20 * DAY_MS).toISOString();
    const outcome = walk([
      { sha: sha("a"), parents: [sha("b")], verdict: "red" },
      { sha: sha("b"), date: stale, verdict: "green" },
    ]);
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("not provably within the 14-day walk bound");
    }
  });

  test("a dateless commit refuses - an age the walk cannot establish fails closed", () => {
    // NaN age: every comparison is false, and the acceptance-window guard
    // reads that as unproven instead of waving the commit through.
    const outcome = walk([
      { sha: sha("a"), parents: [sha("b")], verdict: "red" },
      { sha: sha("b"), date: null, verdict: "green" },
    ]);
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("not provably within");
    }
  });

  test("a far-future committer date refuses - past the skew allowance the age is unprovable", () => {
    // A forged or clock-broken date must not slip past a bound that only
    // looked backwards; a day of ordinary clock skew still passes.
    const outcome = walk([
      { sha: sha("a"), parents: [sha("b")], verdict: "red" },
      { sha: sha("b"), date: new Date(NOW + 3 * DAY_MS).toISOString(), verdict: "green" },
    ]);
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("not provably within");
    }
  });

  test("ordinary clock skew is tolerated - a commit dated minutes ahead still vouches", () => {
    const outcome = walk([
      { sha: sha("a"), parents: [sha("b")], verdict: "red" },
      { sha: sha("b"), date: new Date(NOW + 5 * 60 * 1000).toISOString(), verdict: "green" },
    ]);
    expect(outcome).toEqual({ sha: sha("b"), behind: 1 });
  });

  test("a candidate whose verdict probe fails is skipped, not chosen and not fatal", () => {
    // An API blip on one sha must not halt the heal: the walk moves past
    // it to an older commit, which still has to prove itself green.
    const outcome = walk([
      { sha: sha("a"), parents: [sha("b")], verdict: "red" },
      { sha: sha("b"), parents: [sha("c")], verdict: "error" },
      { sha: sha("c"), verdict: "green" },
    ]);
    expect(outcome).toEqual({ sha: sha("c"), behind: 2 });
  });

  test("only FIRST parents are walked - a merge's green side parent never routes the walk", () => {
    // parents[1] is green; the first-parent chain is red and ends at its
    // root. A listing-order walk (or a parents[1] hop) would return the
    // side branch's commit, which main's history never vouched for.
    const outcome = walk([
      { sha: sha("a"), parents: [sha("b"), sha("e")], verdict: "red" },
      { sha: sha("b"), verdict: "red" },
      { sha: sha("e"), verdict: "green" },
    ]);
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("root commit");
    }
  });

  test("nothing green down to the root commit refuses", () => {
    const outcome = walk([
      { sha: sha("a"), parents: [sha("b")], verdict: "red" },
      { sha: sha("b"), verdict: "none" },
    ]);
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("root commit");
    }
  });

  test("a first-parent chain that leaves the fetched window refuses", () => {
    const outcome = walk([{ sha: sha("a"), parents: [sha("b")], verdict: "red" }]);
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("left the fetched");
    }
  });

  test("a listing that does not contain the tip refuses", () => {
    const outcome = walk([
      { sha: sha("b"), parents: [sha("c")], verdict: "green" },
      { sha: sha("c"), verdict: "green" },
    ]);
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("does not contain the tip");
    }
  });

  test("a failed commits listing refuses - an API failure is never a pass", () => {
    const outcome = walk([{ sha: sha("a"), verdict: "red" }], { listingExit: 1 });
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("listing the commits behind");
      expect(outcome.refusal).toContain("fails closed");
    }
  });

  test("a malformed listing refuses with the shape named, not a TypeError later", () => {
    const gh: GhRunner = (command) =>
      /check-runs/.test(command[2] ?? "")
        ? { exitCode: 0, stdout: JSON.stringify({ check_runs: [] }), stderr: "" }
        : { exitCode: 0, stdout: "not json", stderr: "" };
    const outcome = newestGreenCommit("o/r", sha("a"), { gh, now: NOW, log: () => {} });
    expect(outcome.sha).toBeNull();
    if (outcome.sha === null) {
      expect(outcome.refusal).toContain("not valid JSON");
    }
  });
});
