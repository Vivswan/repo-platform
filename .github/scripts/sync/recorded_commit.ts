// The one judgment of a target's recorded `_commit` (sync and rehearsal):
// a full sha in build history only, never a revspec git would resolve to
// today's tip. docs/migrations.md has the rejection table.

import { capture } from "../shared/proc.ts";

export const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export type RecordedCommit =
  | { kind: "ok"; sha: string }
  | { kind: "not-a-sha" }
  | { kind: "unresolved" }
  | { kind: "not-ancestor" }
  | { kind: "ahead-of-delivered" };

export interface CommitHistory {
  /** The git repository holding the build ref. */
  dir: string;
  /** The build branch's ref in that repository (`refs/remotes/origin/build`
   * in the workflow, `refs/heads/build` in the rehearsal clone). */
  buildRef: string;
  /** The build commit this sync delivers; the recorded commit must be its
   * ancestor. Omitted where nothing is delivered yet (the rehearsal chains
   * its build onto the recorded commit after judging it). */
  deliveredSha?: string;
}

/** Whether `sha` is reachable from `ref` (a commit is its own ancestor).
 * Exit 1 is the answer "no"; anything else is a git failure and throws -
 * an unreadable history must never read as "not an ancestor". */
function isAncestor(dir: string, sha: string, ref: string): boolean {
  const probe = capture(["git", "-C", dir, "merge-base", "--is-ancestor", sha, ref]);
  if (probe.exitCode === 0) return true;
  if (probe.exitCode === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed: ${probe.stderr.trim()}`);
}

export function resolveRecordedCommit(commit: string, history: CommitHistory): RecordedCommit {
  // The shape check comes first, so no revspec ever reaches git.
  if (!FULL_SHA_RE.test(commit)) return { kind: "not-a-sha" };
  const resolved = capture([
    "git",
    "-C",
    history.dir,
    "rev-parse",
    "--verify",
    "--quiet",
    `${commit}^{commit}`,
  ]);
  // --verify --quiet exits 1 for a revision that does not exist and 128
  // for a git failure (no repository, a corrupt store): only the former
  // is an answer about the commit.
  if (resolved.exitCode === 1) return { kind: "unresolved" };
  if (resolved.exitCode !== 0) {
    throw new Error(`git rev-parse failed (exit ${resolved.exitCode}): ${resolved.stderr.trim()}`);
  }
  // A 40-hex tag NAME resolves too; the object must be the value itself.
  if (resolved.stdout.trim() !== commit) return { kind: "unresolved" };
  if (!isAncestor(history.dir, commit, history.buildRef)) return { kind: "not-ancestor" };
  if (
    history.deliveredSha !== undefined &&
    !isAncestor(history.dir, commit, history.deliveredSha)
  ) {
    return { kind: "ahead-of-delivered" };
  }
  return { kind: "ok", sha: commit };
}

/** Why a recorded commit is unusable, for the caller's refusal message.
 * `shown` is the value as the caller may print it (a hide-details target
 * withholds non-sha text). */
export function unusableReason(
  verdict: Exclude<RecordedCommit, { kind: "ok" }>,
  shown: string,
): string {
  switch (verdict.kind) {
    case "not-a-sha":
      return `records a _commit that is not a full 40-hex commit sha (${shown}); the stamp hook writes nothing else, so this file was edited by hand or rendered by an unsupported path`;
    case "unresolved":
      return `records a _commit (${shown}) that is not an object in the build history`;
    case "not-ancestor":
      return `records a _commit (${shown}) that is not a build commit, so it proves nothing about the repository's last sync`;
    case "ahead-of-delivered":
      return `records a _commit (${shown}) that is a build commit AHEAD of the build being delivered; the build branch never moves backwards, so either the recording or the delivered tip is wrong`;
  }
}
