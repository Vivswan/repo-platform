// The build-during-CI handoff: a push-triggered build composes the
// build-branch tree CONCURRENTLY with main's CI run and parks it,
// UNPUBLISHED, at a per-source ref; the workflow_run publisher promotes
// that pre-built tree once all-green completes. Shared by
// build_pending.ts (the writer), publish.ts (the consumer and the
// sweep), and the race-rule tests - one home for the ref grammar and the
// newest-green-wins rule, so the three can never drift.
//
// The refs live in the BRANCH namespace (refs/heads/build-pending/<sha>)
// on purpose: the publisher promotes a pending tree into the executable
// `build` branch on name-match alone, so the namespace must be covered by
// the build-branches-writer ruleset (rulesets only target branches and
// tags) - otherwise any principal with plain contents write could park a
// poisoned tree under the right name and have the official publisher
// stamp and ship it.

export const PENDING_REF_PREFIX = "refs/heads/build-pending/";

/** The unpublished ref a push build parks its tree at. Keyed by the FULL
 * source sha: concurrent pushes get disjoint refs (no overwrite races),
 * the publisher name-matches its own SOURCE_SHA (a pending ref can never
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
 * unresolvable tip stamp is NOT stale (the re-stamp machinery owns
 * damaged stamps), an equal source is NOT stale (the no-change/re-stamp
 * path owns replays), and a DIVERGED source is not stale either (a main
 * history rewrite; the provenance machinery reports it). */
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
