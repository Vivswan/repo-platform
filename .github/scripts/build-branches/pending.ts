// The build-during-CI handoff: a push-triggered build composes the
// build-branch tree CONCURRENTLY with main's CI run and parks it,
// UNPUBLISHED, at a per-source ref; the post-green publisher
// (post-green.yml, called by all-green.yml once the verdict lands green)
// promotes that pre-built tree. Shared by
// build_pending.ts (the writer), publish.ts (the consumer and the
// sweep), and the race-rule tests - one home for the ref grammar and the
// newest-green-wins rule, so the three can never drift.
//
// The refs live in the BRANCH namespace (refs/heads/build-pending/<sha>)
// on purpose: only branches and tags can ever be ruleset-covered, so the
// namespace keeps the OPTION of scoping pending-ref writes to the
// publisher if GitHub's ruleset dialect ever allows it on user
// repositories (today it does not: the required Integration bypass actor
// 422s there, which is why no writer-restricting ruleset exists - see
// .github/settings.yml). Stated plainly: parking a poisoned pending tree
// is therefore equivalent in power to fast-forwarding refs/heads/build
// directly, the documented residual of the executable channel; the sync
// side's provenance rebuild is the boundary for template consumption,
// and publish.ts's shape guard bounds what a malformed pending tree can
// publish.

export const PENDING_REF_PREFIX = "refs/heads/build-pending/";

/** The unpublished ref a push build parks its tree at. Keyed by the FULL
 * source sha: concurrent pushes get disjoint refs (no overwrite races),
 * the publisher name-matches its SOURCE_SHA (a pending ref can never
 * hand it another source's tree), and a re-run of the same push only
 * ever replaces its own content. */
export function pendingRefFor(sourceSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(`pendingRefFor needs a full commit sha (got '${sourceSha}')`);
  }
  return `${PENDING_REF_PREFIX}${sourceSha}`;
}

/** Newest-green-wins: the reason publishing `candidateSource` onto a tip
 * stamped `tipSource` would ROLL THE BRANCH BACK, or "" when publishing
 * may proceed. Under cancel-in-progress: false a queued publisher can
 * run after a newer main already published - its build is stale, and a
 * stale build must never overwrite a newer published tree. An empty or
 * unresolvable tip stamp is NOT stale (publish.ts's stamp-recovery lane
 * owns damaged stamps), an equal source is NOT stale (a replay proceeds
 * to the tree diff, which publishes nothing when nothing changed and
 * republishes on drift), and a DIVERGED source is not stale either (a
 * main history rewrite; the provenance machinery reports it). */
export function staleReason(
  candidateSource: string,
  tipSource: string,
  isAncestor: (ancestor: string, descendant: string) => boolean,
): string {
  if (tipSource === "" || tipSource === candidateSource) return "";
  if (isAncestor(candidateSource, tipSource)) {
    return (
      `the published tip already ships ${tipSource.slice(0, 12)}, which descends from ` +
      `this run's ${candidateSource.slice(0, 12)} - newest-green wins; a stale build ` +
      "never overwrites a newer published tree"
    );
  }
  return "";
}

/** Whether a publish of `candidateSource` supersedes the pending ref
 * whose source leaf is `refSource`: the candidate's own ref is CONSUMED
 * (its tree was just promoted), an ancestor source is always covered (its
 * queued publisher will skip as stale anyway), and refs for NEWER sources
 * never sweep - their own publishers still need them. `isAncestor` must
 * answer false for an unresolvable source (a rewritten-away commit's ref
 * is left for the rewrite's own build to clean up). */
export function refSuperseded(
  refSource: string,
  candidateSource: string,
  isAncestor: (ancestor: string, descendant: string) => boolean,
): boolean {
  if (refSource === candidateSource) return true;
  return isAncestor(refSource, candidateSource);
}
