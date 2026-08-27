#!/usr/bin/env bun
// Composes and publishes the `build` branch (an append-only orphan branch;
// see build-branches.yml's header for the branch model) - the ONE
// generated delivery channel: copier renders from its template/ subtree
// and `uses: ...@build` refs execute its actions/ subtree. Invoked by
// build-branches.yml's "Build and publish" step. On the workflow_run path
// PREBUILT_REF names the push build's parked tree (build_pending.ts), so
// this run only promotes it; without one (schedule, dispatch, or a missing
// pending ref) it composes the tree itself.
//
// A no-op render (byte-identical to the tip) publishes no commit;
// publish.ts records that verdict as a per-source marker ref plus a
// run-owned artifact claim (see publishNoopMarker) so the sync's bounded
// freshness wait can complete without a fleet-visible commit. The one
// deeper residual (see build-branches.yml's concurrency note): freshness
// is stamp-based and the stamp advances only on a CONTENT change, so a
// newer publisher that fully no-ops leaves the older stamp, after which a
// manual rerun of an intermediate source can republish its green-but-
// superseded tree - an operator-induced, cron-healed edge.
//
// Env: RUN_URL, GH_TOKEN, GITHUB_SERVER_URL, GITHUB_REPOSITORY,
// GITHUB_REF, SOURCE_SHA (the commit to publish - the completed CI run's
// head_sha on the workflow_run path, the trigger commit otherwise);
// PREBUILT_REF optional (workflow_run only).

import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { allGreenFailure } from "../shared/all_green.ts";
import {
  commitRunParse,
  commitRunWrite,
  commitStampParse,
  commitStampParseAll,
  commitStampWrite,
} from "../shared/commit_stamp.ts";
import { env, fail, requireEnv, setOutput } from "../shared/gha.ts";
import { BUILD_IDENTITY } from "../shared/git_identity.ts";
import { parseJsonWith } from "../shared/json.ts";
import {
  NOOP_MARKER_REF_PREFIX,
  noopClaimName,
  noopMarkerMessage,
  noopMarkerRefFor,
} from "../shared/noop_marker.ts";
import { capture, must, mustCapture } from "../shared/proc.ts";
import { rebuildBranchTree } from "../shared/rebuild_tree.ts";
import { runVouchesForSource } from "../shared/run_vouches.ts";
import { type OwnRefPolicy, PENDING_REF_PREFIX, refSuperseded, staleReason } from "./pending.ts";

const BRANCH = "build";
/** The branch the retired split-channel era published the composed tree
 * on: the first `build` publish CONTINUES its history (see the seed arm in
 * publish() below). */
const LEGACY_BRANCH = "template";
/** build-branches.yml's publish step name - the step-level publish proof;
 * twin of the PUBLISH_STEP in sync/verify_build_provenance.ts and
 * sync/wait_for_build.ts. */
const PUBLISH_STEP = "Build and publish";
const repository = requireEnv("GITHUB_REPOSITORY");

// The build stamps and composes SOURCE_SHA - the commit the publish's
// run proof can vouch for (run_vouches.ts: the stamped run's head sha IS
// the source, or the source is an on-main ancestor of it). On the
// workflow_run path that is the completed CI run's head_sha (GITHUB_SHA
// there is the CURRENT main tip, which can already be a newer - even red -
// commit this run must not touch); on schedule and dispatch it is the
// trigger commit itself. Composing origin/main NOW instead would break
// exactly the run proof: stamping a newer tip against this run's fixed
// RUN_URL hands the fleet a tip verify_build_provenance rejects (the plan
// job then fails for every repo until the next build self-heals). The
// newer tip's own CI run triggers the build that publishes it. A
// workflow_dispatch aimed at any other ref would publish a build whose
// run can never vouch for it either - refuse before any mutation.
const ref = env("GITHUB_REF");
if (ref !== "" && ref !== "refs/heads/main") {
  fail(
    `Build Branches only publishes from main, but this run was dispatched on '${ref}'. Re-run the workflow on the main branch.`,
  );
}

must(["git", "config", "user.name", BUILD_IDENTITY.name]);
must(["git", "config", "user.email", BUILD_IDENTITY.email]);

function resolves(revspec: string): string {
  const probe = capture(["git", "rev-parse", "--verify", "--quiet", revspec]);
  return probe.exitCode === 0 ? probe.stdout.trimEnd() : "";
}

function isAncestor(ancestor: string, descendant: string): boolean {
  return capture(["git", "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

/** Whether a ref exists on origin, distinguishing ABSENT (git ls-remote
 * --exit-code returns 2) from an OPERATIONAL failure (any other non-zero:
 * a network blip, an auth error). A blip must never read as "branch
 * absent" - that would send the publisher down the bootstrap/orphan path
 * over a live branch and, on the transition seam, mint a `build` history
 * disconnected from the fleet's recorded _commit ancestry. On an
 * operational failure we throw and let the run fail loudly instead. */
function refExistsOnOrigin(ref: string): boolean {
  const probe = capture(["git", "ls-remote", "--exit-code", "origin", ref]);
  if (probe.exitCode === 0) return true;
  if (probe.exitCode === 2) return false;
  throw new Error(
    `git ls-remote for ${ref} failed (exit ${probe.exitCode}): ${probe.stderr.trim()} - an operational failure, not an absent ref; re-run the build`,
  );
}

/** Whether `dir` is a real actions/ directory holding at least one
 * <name>/action.yml - the unified-tree shape the guard in publish()
 * requires. A mere path named actions (a file, a dangling entry in a
 * malformed pending tree) does not count. */
function hasActionManifest(dir: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  return readdirSync(dir, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "action.yml")),
  );
}

// Returns a re-stamp reason when the branch tip's stamp would fail the
// sync's provenance checks, and "" when the stamp is still good. The
// append-only branch only gains a commit on content change, so a fresh
// empty stamp commit from here is the ONLY way to heal a tip whose stamp
// is broken - without this, "dispatch Build Branches" could never clear a
// rejected tip. The tip gets the full battery its sync verification
// (sync/verify_build_provenance.ts) enforces, including one rebuild of
// the stamped source when it lags the current one.
function restampReason(currentSourceSha: string): string {
  const tipMsg = mustCapture(["git", "-C", "/tmp/pub", "log", "-1", "--format=%B"]);
  const prevSrc = commitStampParse(tipMsg);
  if (prevSrc === "") {
    return "re-stamp: tip carries no source stamp";
  }
  // A main history rewrite can orphan the stamp's source while leaving
  // the tree identical; downstream validation resolves that stamp.
  if (resolves(`${prevSrc}^{commit}`) === "") {
    return `re-stamp: previous source ${prevSrc.slice(0, 12)} unreachable`;
  }
  if (!isAncestor(prevSrc, "origin/main")) {
    return `re-stamp: previous source ${prevSrc.slice(0, 12)} not on main history`;
  }
  // A tip whose stamps are old-but-valid replays an older build; the
  // sync's rollback check rejects it, and only a fresh stamp from here
  // can heal the append-only branch. Same walk and same on-main filter
  // as the sync's: no on-main stamp anywhere in the tip's ancestry may
  // be newer than the tip's own.
  const history = mustCapture(["git", "-C", "/tmp/pub", "log", "--format=%B", "HEAD"]);
  for (const stamped of commitStampParseAll(history)) {
    const ancestorSrc = resolves(`${stamped}^{commit}`);
    if (ancestorSrc === "") continue;
    if (!isAncestor(ancestorSrc, "origin/main")) continue;
    if (ancestorSrc !== prevSrc && isAncestor(prevSrc, ancestorSrc)) {
      return `re-stamp: tip source ${prevSrc.slice(0, 12)} is older than stamped ancestor ${ancestorSrc.slice(0, 12)}`;
    }
  }
  const prevRun = commitRunParse(tipMsg);
  if (prevRun === "") {
    return "re-stamp: tip carries no parseable run line";
  }
  const runProbe = capture(["gh", "api", `repos/${repository}/actions/runs/${prevRun}`]);
  if (runProbe.exitCode !== 0) {
    // Only HTTP 404 means the stamped run is gone and a re-stamp can heal
    // it. Any other failure is operational; re-stamping on it would push a
    // needless empty commit onto the append-only branch (and a fleet-wide
    // no-change sync PR), so abort and let a re-run decide.
    if (/HTTP 404/.test(runProbe.stderr)) {
      return `re-stamp: stamped run ${prevRun} does not exist`;
    }
    throw new Error(
      `reading stamped run ${prevRun} failed (${runProbe.stderr.trim()}) - an API failure, not a broken stamp; re-run the build`,
    );
  }
  const run = parseJsonWith(
    z.object({ path: z.string(), conclusion: z.string().nullable(), head_sha: z.string() }),
    runProbe.stdout,
    "publish: actions/runs response",
  );
  // The stamped run VOUCHES for the source when its head sha IS the source
  // or the source is an on-main ancestor of it (run_vouches.ts). Strict
  // head_sha === source is wrong for the workflow_run publisher: GitHub
  // gives that run main's CURRENT tip as its head sha, which can be a
  // later commit than the source it published, so equality would reject a
  // legitimate stamp and re-stamp needlessly.
  if (
    run.path !== ".github/workflows/build-branches.yml" ||
    run.conclusion !== "success" ||
    !runVouchesForSource({
      runHeadSha: run.head_sha,
      sourceSha: prevSrc,
      mainRef: "origin/main",
      resolveCommit: resolves,
      isAncestor,
    })
  ) {
    return `re-stamp: stamped run ${prevRun} does not vouch for source ${prevSrc.slice(0, 12)}`;
  }
  // conclusion=success alone is NOT publish proof: on a red main every
  // step skips via CI_GREEN and the run still concludes success at that
  // head_sha, so a stamp naming such a run would pass the checks above.
  // Require the publish step itself to have succeeded - the same
  // step-level proof the sync side's verify_build_provenance.ts applies
  // (PUBLISH_STEP is its twin constant).
  const jobsProbe = capture(["gh", "api", `repos/${repository}/actions/runs/${prevRun}/jobs`]);
  if (jobsProbe.exitCode !== 0) {
    throw new Error(
      `reading stamped run ${prevRun}'s jobs failed (${jobsProbe.stderr.trim()}) - an API failure, not a broken stamp; re-run the build`,
    );
  }
  const jobs = parseJsonWith(
    z.object({
      jobs: z.array(
        z.object({
          steps: z
            .array(z.object({ name: z.string(), conclusion: z.string().nullable() }))
            .optional(),
        }),
      ),
    }),
    jobsProbe.stdout,
    "publish: runs/jobs response",
  );
  const published = jobs.jobs.some((job) =>
    (job.steps ?? []).some((step) => step.name === PUBLISH_STEP && step.conclusion === "success"),
  );
  if (!published) {
    return `re-stamp: stamped run ${prevRun} never ran its '${PUBLISH_STEP}' step`;
  }
  // The stamps can be individually valid while the TREE is a different
  // source's build (a hand-push of the current build's exact tree over
  // the previous stamps): the sync's tree proof rejects that pair, so
  // prove the stamped source still rebuilds this tree and re-stamp when
  // it does not - or can no longer be rebuilt at all. Tree hashes compare
  // through the same rebuild the sync's verifier uses; the pub side hashes
  // its staged index, which at this point equals the tip commit's tree
  // (a staged content change took the "content change" branch instead).
  if (prevSrc !== currentSourceSha) {
    const srcDir = "/tmp/prev-src";
    const treeDir = "/tmp/prev-tree";
    rmSync(treeDir, { recursive: true, force: true });
    capture(["git", "worktree", "remove", "--force", srcDir]);
    let stampedTree: string | null;
    try {
      stampedTree = rebuildBranchTree({ sourceSha: prevSrc, srcDir, treeDir });
    } catch {
      // An unbuildable stamped source is exactly the "can no longer be
      // rebuilt" case: re-stamp.
      stampedTree = null;
    }
    capture(["git", "worktree", "remove", "--force", srcDir]);
    rmSync(treeDir, { recursive: true, force: true });
    if (stampedTree !== mustCapture(["git", "-C", "/tmp/pub", "write-tree"])) {
      return `re-stamp: the tip tree is not the stamped ${prevSrc.slice(0, 12)} build`;
    }
  }
  return "";
}

/** The publish outcome the footer acts on: a pushed commit, a VERIFIED
 * no-op (content unchanged AND the tip passed restampReason's battery)
 * with the tip it was verified against - carried here so the marker never
 * reaches back into /tmp/pub by convention - or a stale skip (a newer
 * publisher already delivered; nothing to record). Bootstrap and re-stamp
 * both commit, so they are "published". */
type PublishOutcome =
  | { kind: "published" }
  | { kind: "noop"; tipSha: string }
  | { kind: "skipped" };

function publish(sourceSha: string): PublishOutcome {
  console.log(`::group::build ${BRANCH} from ${sourceSha.slice(0, 12)}`);
  for (const dir of ["/tmp/src", "/tmp/tree", "/tmp/pub"]) {
    rmSync(dir, { recursive: true, force: true });
  }
  // The workflow_run path hands over the PUSH run's pre-built tree
  // (build_pending.ts parked it while CI was still executing), so the
  // compose cost was already paid concurrently with CI. Name-matched by
  // construction: the env value is pendingRefFor(SOURCE_SHA), so a
  // pending ref can never hand this run another source's tree. A missing
  // ref (the push build failed, or its queued run was coalesced away)
  // falls back to composing here - slower, never wrong.
  const prebuiltRef = env("PREBUILT_REF");
  let treeSource = "composed here";
  if (prebuiltRef !== "") {
    const fetched = capture(["git", "fetch", "--quiet", "origin", prebuiltRef]);
    if (fetched.exitCode === 0) {
      must(["git", "worktree", "add", "--detach", "/tmp/tree", "FETCH_HEAD"]);
      treeSource = `pre-built (${prebuiltRef})`;
    } else {
      console.log(
        `::warning::no pre-built tree at ${prebuiltRef} (push build failed or was coalesced); composing here instead`,
      );
    }
  }
  if (treeSource === "composed here") {
    // Compose with the SOURCE ref's own script + sources, so a rebuild of
    // an old commit reproduces that commit's composition. The script's
    // dependencies must resolve from that tree, not this checkout.
    must(["git", "worktree", "add", "--detach", "/tmp/src", sourceSha]);
    must(["bun", "install", "--frozen-lockfile", "--cwd", "/tmp/src"]);
    must(["bun", "/tmp/src/.github/scripts/build-branches/branch_tree.ts", "--dest", "/tmp/tree"]);
  }
  console.log(`tree: ${treeSource}`);
  // Unified-tree guard, on EVERY path (composed and pre-built alike): a
  // tree without actions/ is not this branch's shape. The bootstrap case
  // is the sharp end - a queued CI completion for a PRE-unification main
  // commit runs this (new) publisher with an OLD SOURCE_SHA, whose own
  // branch_tree.ts composes the retired template-only tree (jinja
  // filenames, no actions/); minting `build` from it would 404 every
  // fleet @build ref and kill uses: extraction until the next green
  // publish. The staleness check below cannot catch the case where that
  // old source IS the seed tip's stamped source, so the shape check
  // fails closed here instead: a real directory carrying at least one
  // action manifest, not merely a path named actions.
  if (!hasActionManifest("/tmp/tree/actions")) {
    fail(
      `refusing to publish: the tree built from ${sourceSha.slice(0, 12)} carries no actions/ subtree with an action.yml, so the source predates the unified build branch (or a pending tree is malformed). Re-run the workflow for a main commit that carries the unification.`,
    );
  }
  const branchExists = refExistsOnOrigin(`refs/heads/${BRANCH}`);
  if (branchExists) {
    must(["git", "fetch", "--quiet", "origin", BRANCH]);
    must(["git", "worktree", "add", "--detach", "/tmp/pub", `origin/${BRANCH}`]);
    // Newest-green-wins (pending.ts owns the rule): under
    // cancel-in-progress: false a queued publisher can execute after a
    // NEWER main already published - its build is stale and must never
    // roll the branch back. Loud skip, green run: this is normal
    // operation under concurrent pushes, and the newer tip's own run
    // already delivered the newer tree. The check-then-push pair is
    // atomic in effect: the new commit below CHAINS onto the exact tip
    // fetched here, and the plain (never force) push succeeds only while
    // the remote ref still points at that tip - if any other writer
    // advanced it in between, the push is rejected as non-fast-forward
    // instead of rolling anything back (and the workflow's concurrency
    // group serializes publishers anyway, so the rejection arm is a
    // second net, not the plan).
    const tipSource = commitStampParse(
      mustCapture(["git", "-C", "/tmp/pub", "log", "-1", "--format=%B"]),
    );
    const stale = staleReason(
      sourceSha,
      tipSource,
      (ancestor, descendant) =>
        resolves(`${ancestor}^{commit}`) !== "" &&
        resolves(`${descendant}^{commit}`) !== "" &&
        isAncestor(ancestor, descendant),
    );
    if (stale !== "") {
      console.log(`${BRANCH}: skipping publish - ${stale}`);
      console.log("::endgroup::");
      return { kind: "skipped" };
    }
  } else if (refExistsOnOrigin(`refs/heads/${LEGACY_BRANCH}`)) {
    // Transition seam from the retired template/actions split-channel era:
    // the first `build` publish CONTINUES the old template branch's
    // history instead of minting a disconnected orphan, so every fleet
    // repo's recorded _commit (an old template-branch build commit) stays
    // reachable through the new branch. Once the old ref is deleted this
    // arm goes dead and can be removed.
    must(["git", "fetch", "--quiet", "origin", LEGACY_BRANCH]);
    must(["git", "worktree", "add", "--detach", "/tmp/pub", `origin/${LEGACY_BRANCH}`]);
  } else {
    must(["git", "worktree", "add", "--detach", "/tmp/pub", sourceSha]);
    must(["git", "-C", "/tmp/pub", "switch", "--orphan", `build-${BRANCH}`]);
  }
  // --checksum: the quick size+mtime check can miss a changed file when
  // both trees were written in the same second and the content is
  // same-size - and every decision below trusts this tree.
  must(["rsync", "-a", "--delete", "--checksum", "--exclude=.git", "/tmp/tree/", "/tmp/pub/"]);
  must(["git", "-C", "/tmp/pub", "add", "-A"]);
  // A missing branch always publishes: the ref must exist for the sync
  // and the fleet's @build action pins to resolve, even when the composed
  // tree happens to equal the seed tip's.
  const note =
    capture(["git", "-C", "/tmp/pub", "diff", "--cached", "--quiet"]).exitCode !== 0
      ? "content change"
      : branchExists
        ? restampReason(sourceSha)
        : "branch bootstrap";
  if (note === "") {
    console.log(`${BRANCH}: no content change`);
    console.log("::endgroup::");
    return { kind: "noop", tipSha: mustCapture(["git", "-C", "/tmp/pub", "rev-parse", "HEAD"]) };
  }
  must([
    "git",
    "-C",
    "/tmp/pub",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    `build(${BRANCH}): main from ${sourceSha.slice(0, 12)}`,
    "-m",
    commitStampWrite(requireEnv("GITHUB_SERVER_URL"), repository, sourceSha),
    "-m",
    commitRunWrite(requireEnv("RUN_URL")),
  ]);
  // Plain push, never force: the branch is append-only, and the plain
  // push doubles as the compare-and-swap on the tip fetched above.
  must(["git", "-C", "/tmp/pub", "push", "origin", `HEAD:refs/heads/${BRANCH}`]);
  const short = mustCapture(["git", "-C", "/tmp/pub", "rev-parse", "--short", "HEAD"]);
  console.log(`${BRANCH}: pushed ${short} (${note})`);
  console.log("::endgroup::");
  return { kind: "published" };
}

/** Records a build no-op where sync/wait_for_build.ts can see it: the
 * append-only branch gains no commit when the render is byte-identical,
 * so the tip keeps its PREVIOUS source stamp and the waiter's stamp probe
 * would burn its whole wait on every later sync (the next build is also a
 * no-op, so not even the cron heals it). Two writes, and the second is
 * the authority:
 *
 *   1. A tiny orphan commit (empty tree, no parent - nothing
 *      fleet-visible, no copier _commit churn) force-pushed to
 *      noopMarkerRefFor(source): the DISCOVERY pointer. Force because a
 *      re-run's marker does not descend from its predecessor.
 *   2. A claim file whose upload build-branches.yml's next step performs
 *      under the noopClaimName artifact name: the run-owned PROOF the
 *      waiter verifies the pointer against. Only this run, while running,
 *      can attach an artifact to itself - run metadata alone cannot say
 *      which source a run published (run_vouches.ts's residual), so a
 *      marker naming a real run is not enough.
 *
 * Best-effort like the pending-ref sweep: a failed marker push only costs
 * waits (never content), and the next no-op publish, weekly cron
 * included, records a fresh verdict. */
function publishNoopMarker(sourceSha: string, tipSha: string): void {
  const claim = noopClaimName(sourceSha, tipSha);
  const message = noopMarkerMessage(
    requireEnv("GITHUB_SERVER_URL"),
    repository,
    sourceSha,
    tipSha,
    requireEnv("RUN_URL"),
  );
  const emptyTree = mustCapture(["git", "hash-object", "-w", "-t", "tree", "/dev/null"]);
  const marker = mustCapture(["git", "commit-tree", emptyTree, "-m", message]);
  const ref = noopMarkerRefFor(sourceSha);
  const pushed = capture(["git", "push", "--quiet", "--force", "origin", `${marker}:${ref}`]);
  if (pushed.exitCode !== 0) {
    console.log(
      `::warning::could not push the no-op marker to ${ref} (${pushed.stderr.trim()}); syncs will burn their bounded wait until the next no-op publish records a fresh verdict`,
    );
    return;
  }
  writeFileSync("/tmp/noop-claim.txt", `${message}\n`);
  setOutput("noop_claim", claim);
  console.log(
    `${ref}: source ${sourceSha.slice(0, 12)} verified as a no-op against tip ${tipSha.slice(0, 12)} (claim artifact ${claim})`,
  );
}

/** Delete per-source refs under `prefix` that this publish superseded
 * (refSuperseded in pending.ts owns the rule; `ownRef` is its pending
 * -vs-marker policy). Best-effort: a failed delete warns, never reds the
 * run (the refs are per-sha, so leftovers cannot corrupt). */
function sweepSourceRefs(prefix: string, sourceSha: string, ownRef: OwnRefPolicy): void {
  const listing = capture(["git", "ls-remote", "origin", `${prefix}*`]);
  if (listing.exitCode !== 0) {
    console.log(`::warning::could not list ${prefix}* refs; skipping the sweep`);
    return;
  }
  for (const line of listing.stdout.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref === undefined || !ref.startsWith(prefix)) continue;
    const refSource = ref.slice(prefix.length);
    const superseded = refSuperseded(
      refSource,
      sourceSha,
      ownRef,
      (ancestor, descendant) =>
        resolves(`${ancestor}^{commit}`) !== "" && isAncestor(ancestor, descendant),
    );
    if (!superseded) continue;
    const deleted = capture(["git", "push", "--quiet", "origin", "--delete", ref]);
    if (deleted.exitCode !== 0) {
      console.log(`::warning::could not delete superseded ref ${ref}`);
    } else {
      console.log(`swept ${ref}`);
    }
  }
}

// The commit to publish (see the run-proof comment above): the completed
// CI run's head_sha on the workflow_run path, the trigger commit on
// schedule/dispatch - NEVER a bare read of origin/main, which can already
// be a newer (even red) commit while this run was queued.
const sourceSha = requireEnv("SOURCE_SHA");
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  fail(`SOURCE_SHA is not a full commit sha (got '${sourceSha}')`);
}
// Green-source gate, on top of the ref guard above: the workflow_run
// trigger only fires on a successful CI run, but the schedule, dispatch,
// and API paths reach here with no such proof - and the branch ships only
// commits whose all-green gate succeeded. Enforced on the commit actually
// being published (SOURCE_SHA, the same commit the stamp records).
const notGreen = allGreenFailure(repository, sourceSha);
if (notGreen !== null) {
  fail(
    `refusing to publish the build branch: main commit ${sourceSha.slice(0, 12)} is not green - ${notGreen}. The branch only ships green main commits; get CI to a successful run on main's tip, then re-run.`,
  );
}
const outcome = publish(sourceSha);
// Marked only on the VERIFIED no-op: a published run's commit carries the
// fresh stamp itself, and a stale skip has nothing to record - a marker
// racing a newer publisher stays inert through its tip binding anyway
// (the waiter matches it against the tip it actually fetches).
if (outcome.kind === "noop") {
  publishNoopMarker(sourceSha, outcome.tipSha);
}
sweepSourceRefs(PENDING_REF_PREFIX, sourceSha, "consume");
sweepSourceRefs(NOOP_MARKER_REF_PREFIX, sourceSha, "keep");
