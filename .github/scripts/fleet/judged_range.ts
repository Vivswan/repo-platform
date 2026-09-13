// The range is (base, judged commit], the base being the commit the stable tag named before this run moved it, so a
// push whose mover was replaced at the lane is still read by its successor's run (docs/all-green.md).
// BEFORE_SHA is that base, else the push's `before`, all zeros on branch creation.

import { fail, requireEnv } from "../shared/gha.ts";
import { gitAnswersYes, gitResolvedCommit } from "../shared/git_yes_no.ts";
import { mustCapture } from "../shared/proc.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;

export function judgedRangeEnv(): { sha: string; before: string } {
  const sha = requireEnv("SOURCE_SHA");
  if (!FULL_SHA.test(sha)) fail(`SOURCE_SHA is not a full commit sha (got '${sha}')`);
  const before = requireEnv("BEFORE_SHA");
  if (!FULL_SHA.test(before)) fail(`BEFORE_SHA is not a full commit sha (got '${before}')`);
  return { sha, before };
}

export type DiffBase = { kind: "commit"; base: string } | { kind: "empty-tree"; base: string };

export function resolveBase(cwd: string, sha: string, before: string): DiffBase {
  if (/^0+$/.test(before)) {
    return {
      kind: "empty-tree",
      base: mustCapture(["git", "-C", cwd, "hash-object", "-t", "tree", "/dev/null"]),
    };
  }
  const what = `the base ${before.slice(0, 12)}`;
  if (gitResolvedCommit(before, { cwd }) === "") {
    throw new Error(
      `${what} is not in this checkout: fetch the full history (actions/checkout fetch-depth: 0)`,
    );
  }
  // --is-ancestor is inclusive; an equal base is an empty range.
  if (before === sha) {
    throw new Error(`${what} is the judged commit itself: an empty range reads nothing`);
  }
  if (!gitAnswersYes(["merge-base", "--is-ancestor", before, sha], { cwd })) {
    throw new Error(
      `${what} is not an ancestor of ${sha.slice(0, 12)}: the range means nothing ` +
        "(a force-push, a foreign payload, or a tag moved out of band) - the next push to main reads " +
        "from this run's move; dispatch sync-repos.yml by hand for this commit's opt-in",
    );
  }
  return { kind: "commit", base: before };
}

/** First-parent only: one commit per squash merge, never a merged branch's inner commits. */
export function rangeCommits(cwd: string, sha: string, base: DiffBase): string[] {
  const range = base.kind === "empty-tree" ? sha : `${base.base}..${sha}`;
  return mustCapture(["git", "-C", cwd, "rev-list", "--first-parent", "--reverse", range])
    .split("\n")
    .filter((line) => line !== "");
}

export function rangeLabel(sha: string, base: DiffBase): string {
  return `${base.base.slice(0, 12)}..${sha.slice(0, 12)}`;
}
