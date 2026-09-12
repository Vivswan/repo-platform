// Checks 1 and 2 of the provenance proof (docs/build-provenance.md), shared so the sync and the publisher cannot drift.
// verify_build_provenance.ts fails the sync on any reason; publish.ts's no-change skip treats one as "do not skip",
// so a dispatch can heal a bad stamp with a freshly stamped commit.
//
// The rollback walk skips two kinds of ancestor stamp on purpose. Skipping the first opens a replay window, which closes when the
// rewrite publishes or a recovery commit lands:
//   unresolvable (orphaned by a main rewrite)        -> must not block the next publish
//   resolvable but off main (a planted descendant)   -> must not poison the branch against every legitimate build that follows

import { commitStampParseAll } from "./commit_stamp.ts";

/** The git questions, injected so both consumers bring their own repo
 * context (the sync verifies a fetched tip in the checkout, the
 * publisher verifies its scratch branch worktree against origin/main). */
export interface StampCheckGit {
  /** The resolved sha of `<revspec>^{commit}`, "" when unresolvable. */
  resolveCommit: (revspec: string) => string;
  /** git merge-base --is-ancestor. */
  isAncestor: (ancestor: string, descendant: string) => boolean;
}

/** `history` is the full `git log --format=%B` of the tip's ancestry through all parents, so a merge tip cannot hide the previous tip.
 * A reason is a fragment: the sync prepends its subject and appends its rebuild hint, the publisher logs it as the recovery note. */
export function stampUnhealthyReason(options: {
  sourceSha: string;
  history: string;
  mainRef: string;
  git: StampCheckGit;
}): string {
  const { sourceSha, history, mainRef, git } = options;
  if (sourceSha === "") {
    return "the tip carries no parseable source stamp";
  }
  if (git.resolveCommit(sourceSha) === "") {
    return `stamped source ${sourceSha.slice(0, 12)} is unreachable`;
  }
  if (!git.isAncestor(sourceSha, mainRef)) {
    return `stamped source ${sourceSha.slice(0, 12)} is not on main's history`;
  }
  for (const stamped of commitStampParseAll(history)) {
    const ancestorSrc = git.resolveCommit(stamped);
    if (ancestorSrc === "") continue;
    if (!git.isAncestor(ancestorSrc, mainRef)) continue;
    if (ancestorSrc !== sourceSha && git.isAncestor(sourceSha, ancestorSrc)) {
      return `the history already stamped the newer source ${ancestorSrc.slice(0, 12)} - the tip replays an older build`;
    }
  }
  return "";
}
