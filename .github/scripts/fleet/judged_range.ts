// The range the read-directives leg covers: (newest ancestor build stamp, judged commit], so a
// push whose CI run was evicted is still read (docs/all-green.md).
// Env (judgedRangeEnv): SOURCE_SHA, BEFORE_SHA (the push's `before`, all zeros on branch creation).

import { commitStampParseAll } from "../shared/commit_stamp.ts";
import { fail, requireEnv } from "../shared/gha.ts";
import { gitAnswersYes } from "../shared/git_yes_no.ts";
import { mustCapture } from "../shared/proc.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const BUILD_REF = "refs/remotes/origin/build";

export function judgedRangeEnv(): { sha: string; before: string } {
  const sha = requireEnv("SOURCE_SHA");
  if (!FULL_SHA.test(sha)) fail(`SOURCE_SHA is not a full commit sha (got '${sha}')`);
  const before = requireEnv("BEFORE_SHA");
  if (!FULL_SHA.test(before)) fail(`BEFORE_SHA is not a full commit sha (got '${before}')`);
  return { sha, before };
}

export type DiffBase =
  | { kind: "build-stamp"; base: string }
  | { kind: "push-before"; base: string }
  | { kind: "empty-tree"; base: string };

/** The newest build stamp that is a strict ancestor of `sha`, verified in the checkout at `cwd`;
 *  the push's `before` (the empty tree when all zeros) only when no build branch exists or its
 *  every stamp is `sha` itself (the first publish ever, landed by this run). An unstamped build
 *  branch, or one with no ancestor stamp at all, is refused. */
export function resolveBase(cwd: string, sha: string, before: string): DiffBase {
  const stamped = stampedBase(cwd, sha);
  if (stamped !== undefined) return stamped;
  if (/^0+$/.test(before)) {
    return {
      kind: "empty-tree",
      base: mustCapture(["git", "-C", cwd, "hash-object", "-t", "tree", "/dev/null"]),
    };
  }
  const what = "the push base";
  requireInCheckout(cwd, what, before);
  // --is-ancestor is inclusive; an equal base is an empty range.
  if (before === sha) {
    throw new Error(
      `${what} ${before.slice(0, 12)} is the judged commit itself: an empty range says nothing about the push`,
    );
  }
  if (!gitAnswersYes(["merge-base", "--is-ancestor", before, sha], { cwd })) {
    throw new Error(notAncestor(what, before, sha));
  }
  return { kind: "push-before", base: before };
}

// The build tip is not always this run's publish: a re-run of an older commit's legs finds the
// tip stamped with a later commit, and an older stamp is still a sound base for that commit.
function stampedBase(cwd: string, sha: string): DiffBase | undefined {
  if (!gitAnswersYes(["rev-parse", "--verify", "--quiet", `${BUILD_REF}^{commit}`], { cwd })) {
    return undefined;
  }
  const stamps = commitStampParseAll(
    mustCapture(["git", "-C", cwd, "log", "--format=%B", BUILD_REF]),
  );
  if (stamps.length === 0) {
    throw new Error(
      "the build branch carries no stamped source in its whole history: publish.ts stamps every build commit, so this branch was not published by it - reset it (dispatch post-green.yml with sha=<green main commit>) before the post-green legs read it",
    );
  }
  const candidates = stamps.filter((stamped) => stamped !== sha);
  if (candidates.length === 0) return undefined;
  const what = "the build tip's stamped source";
  for (const stamped of candidates) {
    requireInCheckout(cwd, what, stamped);
    if (gitAnswersYes(["merge-base", "--is-ancestor", stamped, sha], { cwd })) {
      return { kind: "build-stamp", base: stamped };
    }
  }
  throw new Error(notAncestor(what, candidates[0], sha));
}

function requireInCheckout(cwd: string, what: string, commit: string): void {
  if (!gitAnswersYes(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd })) {
    throw new Error(
      `${what} ${commit.slice(0, 12)} is not in this checkout: fetch the full history (actions/checkout fetch-depth: 0)`,
    );
  }
}

function notAncestor(what: string, base: string, sha: string): string {
  return (
    `${what} ${base.slice(0, 12)} is not an ancestor of ${sha.slice(0, 12)}: the range means ` +
    "nothing (a force-push, a foreign payload, or a tampered build stamp) - publish a green main " +
    "commit by hand (dispatch post-green.yml with sha=<green main commit>) to reset the base"
  );
}

/** The commits in (base, sha] along main's first-parent line, oldest first: every push since the
 *  last publish, one commit per squash merge. An empty-tree base means the whole history. */
export function rangeCommits(cwd: string, sha: string, base: DiffBase): string[] {
  const range = base.kind === "empty-tree" ? sha : `${base.base}..${sha}`;
  return mustCapture(["git", "-C", cwd, "rev-list", "--first-parent", "--reverse", range])
    .split("\n")
    .filter((line) => line !== "");
}

export function rangeLabel(sha: string, base: DiffBase): string {
  return `${base.base.slice(0, 12)}..${sha.slice(0, 12)}`;
}
