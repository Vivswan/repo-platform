// The range every post-green leg covers: (newest earlier build stamp, judged commit], so a push
// whose CI run was evicted is still read (docs/all-green.md). One owner for both legs.
// Env (judgedRangeEnv): SOURCE_SHA, BEFORE_SHA (the push's `before`, all zeros on branch creation).

import { commitStampParseAll } from "../shared/commit_stamp.ts";
import { fail, requireEnv } from "../shared/gha.ts";
import { capture, mustCapture } from "../shared/proc.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const BUILD_REF = "refs/remotes/origin/build";

export function judgedRangeEnv(): { sha: string; before: string } {
  const sha = requireEnv("SOURCE_SHA");
  if (!FULL_SHA.test(sha)) fail(`SOURCE_SHA is not a full commit sha (got '${sha}')`);
  const before = requireEnv("BEFORE_SHA");
  if (!FULL_SHA.test(before)) fail(`BEFORE_SHA is not a full commit sha (got '${before}')`);
  return { sha, before };
}

/** A git yes/no question answers with exit 0 or 1; anything else (or a
 *  deadline expiry) is an errored look, never a verdict. */
function gitAnswersYes(cwd: string, args: string[]): boolean {
  const probe = capture(["git", "-C", cwd, ...args]);
  if (probe.timedOut || (probe.exitCode !== 0 && probe.exitCode !== 1)) {
    throw new Error(`git ${args[0]} could not answer (exit ${probe.exitCode}); refusing to guess`);
  }
  return probe.exitCode === 0;
}

export type DiffBase =
  | { kind: "build-stamp"; base: string }
  | { kind: "push-before"; base: string }
  | { kind: "empty-tree"; base: string };

/** The newest build stamp that is not `sha` itself (the tip may be THIS run's publish), verified
 *  a strict ancestor of `sha` in the checkout at `cwd`; the push's `before` (the empty tree when
 *  all zeros) only when no older stamp exists. An unstamped build branch is refused. */
export function resolveBase(cwd: string, sha: string, before: string): DiffBase {
  const base = findBase(cwd, sha, before);
  if (base.kind !== "empty-tree") {
    const what = base.kind === "build-stamp" ? "the build tip's stamped source" : "the push base";
    if (!gitAnswersYes(cwd, ["rev-parse", "--verify", "--quiet", `${base.base}^{commit}`])) {
      throw new Error(
        `${what} ${base.base.slice(0, 12)} is not in this checkout: fetch the full history (actions/checkout fetch-depth: 0)`,
      );
    }
    // --is-ancestor is inclusive; an equal base is an empty range.
    if (base.base === sha) {
      throw new Error(
        `${what} ${base.base.slice(0, 12)} is the judged commit itself: an empty range says nothing about the push`,
      );
    }
    if (!gitAnswersYes(cwd, ["merge-base", "--is-ancestor", base.base, sha])) {
      throw new Error(
        `${what} ${base.base.slice(0, 12)} is not an ancestor of ${sha.slice(0, 12)}: the range means ` +
          "nothing (a force-push, a foreign payload, or a tampered build stamp) - publish a green main " +
          "commit by hand (dispatch post-green.yml with sha=<green main commit>) to reset the base",
      );
    }
  }
  return base;
}

function findBase(cwd: string, sha: string, before: string): DiffBase {
  if (gitAnswersYes(cwd, ["rev-parse", "--verify", "--quiet", `${BUILD_REF}^{commit}`])) {
    const stamps = commitStampParseAll(
      mustCapture(["git", "-C", cwd, "log", "--format=%B", BUILD_REF]),
    );
    if (stamps.length === 0) {
      throw new Error(
        "the build branch carries no stamped source in its whole history: publish.ts stamps every build commit, so this branch was not published by it - reset it (dispatch post-green.yml with sha=<green main commit>) before the post-green legs read it",
      );
    }
    const base = stamps.find((stamped) => stamped !== sha);
    if (base !== undefined) return { kind: "build-stamp", base };
  }
  if (/^0+$/.test(before)) {
    return {
      kind: "empty-tree",
      base: mustCapture(["git", "-C", cwd, "hash-object", "-t", "tree", "/dev/null"]),
    };
  }
  return { kind: "push-before", base: before };
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
