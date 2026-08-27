// The no-op publication marker: publish.ts's answer for a green source
// whose render leaves the template branch byte-identical. The append-only
// branch gains no commit then, so the tip keeps the PREVIOUS source stamp
// and sync/wait_for_build.ts's stamp-only freshness probe would burn its
// whole wait on every later sync (the next build is also a no-op, so the
// cron cannot heal it). Instead the publisher force-pushes a tiny orphan
// commit (empty tree, no parent - nothing fleet-visible, no copier
// _commit churn) to noopMarkerRefFor(source) recording "source X verified
// as a no-op against template tip Y". publish.ts writes the message and
// the claim name; wait_for_build.ts parses them back - the shapes live
// here alone, next to commit_stamp.ts's, which the marker reuses for its
// source and run lines.
//
// Trust model: refs/build-meta/* is outside refs/heads/, so no branch
// ruleset guards it - anyone with push access can write it, exactly like
// the template branch itself. The marker therefore carries NO authority:
// it is a pointer the waiter VERIFIES against run-owned evidence, the
// noopClaimName artifact the stamped run uploaded about itself. Artifacts
// cannot be attached to a completed run, so only the real publisher path
// (ref-guarded to main, green-gated, no-op-verified) can mint one - run
// metadata alone cannot say WHICH source a run published, run_vouches.ts's
// documented residual. The worst a forged or lost marker costs is wait
// time - never content, which resolve_refs.ts + verify_build_provenance.ts
// still fully verify on the tip before anything ships.

import { commitRunWrite, commitStampWrite } from "./commit_stamp.ts";

/** Not under refs/heads/: the marker must never look like a branch (no
 * checkout, no branch protection semantics) - the refs/build-pending/
 * parking namespace's reasoning. Per-source like pending refs: concurrent
 * sources get disjoint refs, the waiter fetches exactly its own source's
 * verdict, and superseded markers are swept without touching live ones. */
export const NOOP_MARKER_REF_PREFIX = "refs/build-meta/template-noop/";

function requireSha(sha: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${label} needs a full commit sha (got '${sha}')`);
  }
}

/** The marker ref recording `sourceSha`'s no-op verdict. */
export function noopMarkerRefFor(sourceSha: string): string {
  requireSha(sourceSha, "noopMarkerRefFor");
  return `${NOOP_MARKER_REF_PREFIX}${sourceSha}`;
}

/** The run-owned artifact name binding the claim to its run: the NAME is
 * the evidence (the waiter matches it in the run's artifact listing), the
 * file behind it is informational. */
export function noopClaimName(sourceSha: string, tipSha: string): string {
  requireSha(sourceSha, "noopClaimName source");
  requireSha(tipSha, "noopClaimName tip");
  return `template-noop-${sourceSha}-${tipSha}`;
}

/** The full marker commit message: the standard source/run stamp lines
 * plus a tip line binding the claim to the exact template tip it was
 * verified against - a marker about an older tip must read as stale, not
 * as freshness for whatever the tip is now. */
export function noopMarkerMessage(
  serverUrl: string,
  repository: string,
  sourceSha: string,
  tipSha: string,
  runUrl: string,
): string {
  return [
    `build(template): source ${sourceSha.slice(0, 12)} is a no-op against tip ${tipSha.slice(0, 12)}`,
    "",
    commitStampWrite(serverUrl, repository, sourceSha),
    `tip: ${serverUrl}/${repository}/commit/${tipSha}`,
    commitRunWrite(runUrl),
  ].join("\n");
}

// Only a full 40-hex sha parses, for commit_stamp.ts's reason: the line
// is plain text anyone can write, and a smuggled revspec would re-resolve
// differently on every read.
const TIP_RE = /^tip: .*\/commit\/([0-9a-f]{40})$/;

/** The marker's bound template tip sha (empty when there is none). */
export function noopMarkerTipParse(message: string): string {
  for (const line of message.split("\n")) {
    const match = line.match(TIP_RE);
    if (match) return match[1];
  }
  return "";
}
