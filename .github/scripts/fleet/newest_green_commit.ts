// The scheduled settings heal's fallback resolver: the newest commit
// BEHIND a red main tip that CI has vouched for. require_green_commit.ts
// calls this only on the schedule leg, only after the tip itself refused
// the full bounded wait - push and dispatch runs stay tip-gated there,
// because applying the checked-out commit is their whole point.
//
// The walk follows main's FIRST-PARENT chain from the tip (via each
// commit's parents[0] over one commits-listing call - main is
// linear-history protected, but the chain is followed explicitly so a
// merge commit could never route the walk through a side branch), and
// probes each ancestor with the SAME all-green predicate the tip faced
// (shared/all_green.ts): the never-write-from-an-unvouched-commit
// property holds on the fallback path exactly as on the fast path.
//
// The walk is BOUNDED twice, and exhausting either bound is a loud
// refusal - the heal then stays halted, the pre-fallback behavior as the
// floor:
//   - MAX_COMMITS (50): an unbounded walk on a long-red main is its own
//     hang - 50 probes is the API-call ceiling, and 50 commits outlasts
//     any plausible red window on this repo's push volume;
//   - MAX_AGE_DAYS (14): a green commit older than two weeks is not a
//     heal source, it is a rollback - by then the halt itself is the
//     signal a human must see, not paper over.
//
// Fail-closed at every edge: a failed listing, a tip missing from it, a
// chain that leaves the fetched window, a root commit, and a dateless or
// future-dated commit (beyond a day of clock skew) all refuse. One
// deliberate exception: a candidate whose verdict probe returns a
// NONZERO exit (an API blip on one sha) is skipped, not fatal - the walk
// moves on to an older commit, which is still green-vouched if chosen,
// and a systematic outage exhausts the bound and refuses anyway. A probe
// that returns success with a malformed body still exits the whole
// process (the shared predicate's parser owns that), which is the same
// halt fail-closed reaches by another door.

import { z } from "zod";
import { allGreenFailure, type GhRunner } from "../shared/all_green.ts";
import { parseJsonWithThrow } from "../shared/json.ts";
import { lastLine } from "../shared/lines.ts";
import { capture } from "../shared/proc.ts";

/** The commit-count bound: also the size of the single listing page the
 * walk reads (the API caps a page at 100), so the window and the bound
 * can never disagree. */
export const MAX_COMMITS = 50;

/** The age bound, in days. */
export const MAX_AGE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

const commitsSchema = z.array(
  z.object({
    sha: z.string(),
    commit: z.object({
      committer: z.object({ date: z.string() }).nullable(),
    }),
    parents: z.array(z.object({ sha: z.string() })),
  }),
);

/** Matches all_green.ts's bounded default runner: an unbounded listing
 * probe would hang the scheduled heal on a stalled connection. */
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "15000");

const boundedCapture: GhRunner = (command) => capture(command, { timeoutMs: PROBE_TIMEOUT_MS });

export interface GreenWalkOptions {
  /** Commit-count bound; tests shrink it. Must stay under the API's
   * 100-per-page cap or the window ends before the bound does (which
   * still refuses, just with the window's reason). */
  maxCommits?: number;
  /** Age bound in milliseconds. */
  maxAgeMs?: number;
  /** Injectable runner for BOTH the listing and the per-sha verdict
   * probes, so tests never touch the network. */
  gh?: GhRunner;
  /** The walk's clock (epoch ms), injectable for the age-bound tests. */
  now?: number;
  log?: (message: string) => void;
}

/** Either the newest green commit behind the tip (with its distance), or
 * the one-line reason no commit may be vouched - never a bare null, so a
 * caller cannot drop the reason on the floor. */
export type GreenWalkOutcome = { sha: string; behind: number } | { sha: null; refusal: string };

/** Walks main's first-parent chain from `tip` (exclusive - the caller
 * already probed the tip with the full bounded wait) and returns the
 * first ancestor with a completed, successful all-green verdict, or the
 * refusal when the bounded walk finds none. */
export function newestGreenCommit(
  repository: string,
  tip: string,
  options: GreenWalkOptions = {},
): GreenWalkOutcome {
  const maxCommits = options.maxCommits ?? MAX_COMMITS;
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_DAYS * DAY_MS;
  const gh = options.gh ?? boundedCapture;
  const now = options.now ?? Date.now();
  const log = options.log ?? console.log;

  // One page, sized to the bound plus the tip itself: the walk can never
  // need a commit the page cannot hold, so pagination (and its shifting
  // windows) never enters the picture.
  const listing = gh([
    "gh",
    "api",
    `repos/${repository}/commits?sha=${tip}&per_page=${Math.min(maxCommits + 1, 100)}`,
  ]);
  if (listing.exitCode !== 0) {
    const detail = lastLine(listing.stderr + listing.stdout);
    return {
      sha: null,
      refusal: `listing the commits behind ${tip.slice(0, 12)} failed (${detail === "" ? `exit ${listing.exitCode}` : detail}) - an API failure, not proof nothing is green, but the walk fails closed`,
    };
  }
  let commits: z.infer<typeof commitsSchema>;
  try {
    commits = parseJsonWithThrow(commitsSchema, listing.stdout, "newest_green_commit: listing");
  } catch (error) {
    return {
      sha: null,
      refusal: error instanceof Error ? error.message : String(error),
    };
  }
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  let current = bySha.get(tip);
  if (current === undefined) {
    return {
      sha: null,
      refusal: `the commits listing at ${tip.slice(0, 12)} does not contain the tip itself - refusing to walk a window that cannot be anchored`,
    };
  }
  for (let behind = 1; ; behind++) {
    // THE COMMIT-COUNT BOUND (a registered guard - guard_registry.ts
    // walk-commit-bound): without it a long-red main turns the nightly
    // heal into an unbounded probe loop, and a green commit arbitrarily
    // far behind would be applied as if it were current state.
    if (behind > maxCommits) {
      return {
        sha: null,
        refusal: `no green commit within ${maxCommits} commits behind the tip - the walk is bounded on purpose, and past it the halt itself is the signal`,
      };
    }
    const parentSha = current.parents[0]?.sha;
    if (parentSha === undefined) {
      return {
        sha: null,
        refusal: `the walk reached the root commit without finding a green one`,
      };
    }
    const candidate = bySha.get(parentSha);
    if (candidate === undefined) {
      return {
        sha: null,
        refusal: `the first-parent chain left the fetched ${commits.length}-commit window at ${parentSha.slice(0, 12)} - refusing rather than walking commits the listing never showed`,
      };
    }
    // THE AGE BOUND (a registered guard - guard_registry.ts
    // walk-age-bound). One acceptance window, entered by proof: a
    // missing or unparseable date is NaN (every NaN comparison is
    // false), and a FUTURE date past a day of clock skew is as
    // unprovable as a stale one - both refuse rather than pass.
    const date = candidate.commit.committer?.date;
    const ageMs = date === undefined ? Number.NaN : now - Date.parse(date);
    if (!(ageMs >= -DAY_MS && ageMs <= maxAgeMs)) {
      return {
        sha: null,
        refusal: `commit ${candidate.sha.slice(0, 12)} (${behind} behind the tip) is not provably within the ${Math.round(maxAgeMs / DAY_MS)}-day walk bound - stale means a rollback, and a dateless or future-dated commit cannot vouch for its age at all`,
      };
    }
    // THE FALLBACK'S OWN VOUCH (a registered guard - guard_registry.ts
    // walk-vouches-candidates): the same predicate the tip faced, zero
    // extra wait - a historical commit's verdict either exists or never
    // will, and a pending one is simply not chosen.
    const notGreen = allGreenFailure(repository, candidate.sha, gh, { deadlineMs: 0 });
    if (notGreen === null) {
      return { sha: candidate.sha, behind };
    }
    log(
      `commit ${candidate.sha.slice(0, 12)} (${behind} behind the tip) is not green: ${notGreen}`,
    );
    current = candidate;
  }
}
