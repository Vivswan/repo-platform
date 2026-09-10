// The build tip's STAMP-health battery: checks 1 (main history) and 2 (no
// rollback) of the sync's provenance gate (docs/build-provenance.md, "The
// provenance proof"), shared with the publisher so the two can never
// drift: verify_build_provenance.ts fails the sync on any reason here, and
// publish.ts's no-change skip guard treats a reason as "do not skip", so a
// dispatch can always heal a tampered, unparsable, or orphaned stamp with
// a freshly stamped commit instead of wedging every sync until the next
// content change.
//
// The rollback walk covers every ancestor through all parents (a merge tip
// cannot hide the previous tip) plus the tip itself, whose own stamp
// compares equal. Only stamps that resolve AND sit on main's history order
// the comparison: a planted stamp naming an off-main DESCENDANT of main's
// tip must not poison the branch against every legitimate build that
// follows, and stamps orphaned by a main history rewrite must not block
// the next publish (the replay window that opens lasts until the
// rewrite's own push publishes, or a stamp-recovery commit lands).

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

/** The reason `sourceSha` (the tip's parsed source stamp; "" when the
 * tip carries none) fails the stamp-health battery against `history`
 * (the full `git log --format=%B` of the tip's ancestry), or "" when
 * healthy. Reasons are caller-agnostic fragments: the sync prepends its
 * subject and appends its rebuild hint, the publisher logs them as the
 * recovery note. */
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
