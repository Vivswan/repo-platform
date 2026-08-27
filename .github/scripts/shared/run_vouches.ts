// The run-proof vouching rule, stated ONCE for its two enforcement points:
// publish.ts's re-stamp check and sync/verify_build_provenance.ts's check 3.
//
// A stamped build run vouches for a stamped source commit when its head
// sha IS that source, or when the source is an on-main ancestor of its
// head. Strict equality alone is impossible for the workflow_run
// publisher: GitHub gives that run the default branch's CURRENT tip as
// its head sha (not the triggering CI run's commit), and main can have
// advanced past the source by the time the run is created. The ancestor
// arm still requires a real, successful build-branches run at-or-after
// the source on main history; what it deliberately does NOT prove is that
// the run published THIS source - the rollback walk (no stamped ancestor
// newer than the tip's own source) and the deterministic tree-rebuild
// proof are what pin the content, and resolve_refs.ts's all-green check
// is what proves the source's CI state. The residual a forged stamp gains
// under this rule is naming a LATER main run to vouch for an EARLIER
// green source it contains - which the rollback walk caps at the newest
// source already stamped in the branch's history, so it can never roll
// the fleet back.

/** Whether a build run at `runHeadSha` vouches for `sourceSha`. The git
 * questions are injected: `resolveCommit` returns the resolved sha or ""
 * (an unresolvable head can only vouch by equality), `isAncestor` answers
 * merge-base --is-ancestor, and `mainRef` names the main ref to check
 * membership against ("origin/main" on the publisher, the fetched
 * "refs/remotes/origin/main" on the sync side). */
export function runVouchesForSource(options: {
  runHeadSha: string;
  sourceSha: string;
  mainRef: string;
  resolveCommit: (revspec: string) => string;
  isAncestor: (ancestor: string, descendant: string) => boolean;
}): boolean {
  const { runHeadSha, sourceSha, mainRef, resolveCommit, isAncestor } = options;
  if (runHeadSha === sourceSha) return true;
  return (
    resolveCommit(runHeadSha) !== "" &&
    isAncestor(runHeadSha, mainRef) &&
    isAncestor(sourceSha, runHeadSha)
  );
}
