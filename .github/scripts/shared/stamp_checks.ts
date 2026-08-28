// The build tip's STAMP-health battery - checks 1 and 2 of the sync's
// provenance gate, shared with the publisher so the two can never drift:
//
//   - sync/verify_build_provenance.ts FAILS the sync on any reason here
//     (then adds its tree proof, the content anchor);
//   - build-branches/publish.ts's no-change skip guard treats a reason
//     as "do not skip": an unchanged composed tree skips the publish
//     only when the tip's stamp is healthy, so dispatching Build
//     Branches can always heal a tampered, unparseable, or orphaned
//     stamp with a freshly stamped commit - without the guard, a
//     tree-identical tip with a broken stamp would wedge every sync
//     until the next content change.
//
// Check 1 - main history: publish.ts only ever stamps main-history shas,
// so anything else was not the builder. Check 2 - no rollback: no
// on-main stamp anywhere in the tip's ancestry may be strictly newer
// than the tip's own; the builder's sources only move forward and the
// branch is append-only, so a replayed OLD build fails here even though
// its tree rebuilds cleanly. The walk covers every ancestor through all
// parents (a merge tip cannot hide the previous tip) plus the tip
// itself, whose own stamp compares equal and passes. Only stamps that
// resolve AND sit on main's history order the comparison: a planted
// stamp naming an off-main DESCENDANT of main's tip must not poison the
// branch against every legitimate build that follows, and stamps
// orphaned or de-mained by a main history rewrite must not block the
// next publish (the rewrite-window replay this opens lasts until the
// rewrite's own push triggers the next successful publish - a
// stamp-recovery commit closes it too).

import { commitStampParseAll } from "./commit_stamp.ts";

/** The git questions, injected so both consumers bring their own repo
 * context (the sync verifies a fetched tip in the checkout, the
 * publisher verifies /tmp/pub against origin/main). */
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
