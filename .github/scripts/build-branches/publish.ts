#!/usr/bin/env bun
// Composes and publishes the two delivery branches - `template` (the
// append-only orphan branch copier consumes; see build-branches.yml's
// header for the branch model) and `actions` (the extraction-safe branch
// fleet `uses:` refs execute). Invoked by build-branches.yml's "Build and
// publish" step. On the workflow_run path PREBUILT_REF names the push
// build's parked tree (build_pending.ts), so this run only promotes it;
// without one (schedule, dispatch, or a missing pending ref) it composes
// the tree itself.
//
// One newest-green preflight gates BOTH branches, both commits are
// prepared unpushed, and a SINGLE atomic push lands whichever of the two
// changed - each changed ref leased against its preflight tip, and any
// unchanged-but-existing ref carried along as a lease-only no-op. So no
// interleaving of runs, no partial failure, and no concurrent publisher
// moving the branch this run left unchanged can leave the executable
// actions ref carrying a different source than the template tree (fleet
// workflows would execute one commit's actions against another commit's
// renders). A branch whose content is unchanged does keep its own older
// source stamp - the two stamps can legitimately differ - and neither ref
// rolls back or splits under a stale run in the common case. The one
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

import { rmSync } from "node:fs";
import { z } from "zod";
import { allGreenFailure } from "../shared/all_green.ts";
import {
  commitRunParse,
  commitRunWrite,
  commitStampParse,
  commitStampParseAll,
  commitStampWrite,
} from "../shared/commit_stamp.ts";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { BUILD_IDENTITY } from "../shared/git_identity.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture, must, mustCapture } from "../shared/proc.ts";
import { rebuildBranchTree } from "../shared/rebuild_tree.ts";
import { runVouchesForSource } from "../shared/run_vouches.ts";
import { PENDING_REF_PREFIX, staleReason } from "./pending.ts";

const BRANCH = "template";
/** The sibling branch carrying ONLY actions/ + a README: `uses: ...@ref`
 * downloads the whole branch tarball, and extraction dies on the composed
 * tree's jinja-expression filenames - so action refs get their own branch
 * with no composed tree at all (publish_actions.ts's header has the full
 * story). Published from the same source commit, behind the same green
 * gate, in the same atomic push as the template branch below. */
const ACTIONS_BRANCH = "actions";
/** build-branches.yml's publish step name - the step-level publish proof;
 * twin of verify_build_provenance.ts's PUBLISH_STEP on the sync side. */
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
 * over a live branch and rewrite its history. On an operational failure
 * we throw and let the run fail loudly instead. */
function refExistsOnOrigin(ref: string): boolean {
  const probe = capture(["git", "ls-remote", "--exit-code", "origin", ref]);
  if (probe.exitCode === 0) return true;
  if (probe.exitCode === 2) return false;
  throw new Error(
    `git ls-remote for ${ref} failed (exit ${probe.exitCode}): ${probe.stderr.trim()} - an operational failure, not an absent ref; re-run the build`,
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

/** A branch commit prepared in a worktree, not yet pushed: the atomic
 * push at the end is the ONLY place a ref moves. */
interface PreparedBranch {
  branch: string;
  /** The worktree whose HEAD is the commit to push. */
  dir: string;
  note: string;
}

/** Prepares the `actions` branch commit: actions/ + README from the
 * SOURCE commit's own tree (same discipline as the template compose - a
 * rebuild of an old commit reproduces that commit's actions), appended to
 * the existing branch (orphan bootstrap on first publish), stamped with
 * the same source + run lines. Append-only, no-change returns null -
 * mirroring the template branch's model; the two land in one atomic
 * push from one green gate. */
function prepareActionsBranch(sourceSha: string): PreparedBranch | null {
  console.log(`::group::build ${ACTIONS_BRANCH} from ${sourceSha.slice(0, 12)}`);
  for (const dir of ["/tmp/actions-src", "/tmp/actions-tree", "/tmp/actions-pub"]) {
    rmSync(dir, { recursive: true, force: true });
  }
  must(["git", "worktree", "add", "--detach", "/tmp/actions-src", sourceSha]);
  must(["bun", "install", "--frozen-lockfile", "--cwd", "/tmp/actions-src"]);
  must([
    "bun",
    "/tmp/actions-src/.github/scripts/build-branches/publish_actions.ts",
    "--dest",
    "/tmp/actions-tree",
  ]);
  const exists = refExistsOnOrigin(`refs/heads/${ACTIONS_BRANCH}`);
  if (exists) {
    must(["git", "fetch", "--quiet", "origin", ACTIONS_BRANCH]);
    must(["git", "worktree", "add", "--detach", "/tmp/actions-pub", `origin/${ACTIONS_BRANCH}`]);
  } else {
    must(["git", "worktree", "add", "--detach", "/tmp/actions-pub", sourceSha]);
    must(["git", "-C", "/tmp/actions-pub", "switch", "--orphan", `build-${ACTIONS_BRANCH}`]);
  }
  must([
    "rsync",
    "-a",
    "--delete",
    "--checksum",
    "--exclude=.git",
    "/tmp/actions-tree/",
    "/tmp/actions-pub/",
  ]);
  must(["git", "-C", "/tmp/actions-pub", "add", "-A"]);
  const changed =
    capture(["git", "-C", "/tmp/actions-pub", "diff", "--cached", "--quiet"]).exitCode !== 0;
  console.log("::endgroup::");
  // A missing branch always publishes: the ref must exist for the fleet's
  // @actions pins to resolve, even when the tree matches the seed's.
  if (!changed && exists) {
    console.log(`${ACTIONS_BRANCH}: no content change`);
    return null;
  }
  must([
    "git",
    "-C",
    "/tmp/actions-pub",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    `build(${ACTIONS_BRANCH}): main from ${sourceSha.slice(0, 12)}`,
    "-m",
    commitStampWrite(requireEnv("GITHUB_SERVER_URL"), repository, sourceSha),
    "-m",
    commitRunWrite(requireEnv("RUN_URL")),
  ]);
  return {
    branch: ACTIONS_BRANCH,
    dir: "/tmp/actions-pub",
    note: changed ? "content change" : "branch bootstrap",
  };
}

function prepareTemplateBranch(sourceSha: string): PreparedBranch | null {
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
  const branchExists = refExistsOnOrigin(`refs/heads/${BRANCH}`);
  if (branchExists) {
    must(["git", "fetch", "--quiet", "origin", BRANCH]);
    must(["git", "worktree", "add", "--detach", "/tmp/pub", `origin/${BRANCH}`]);
  } else if (refExistsOnOrigin("refs/heads/staging")) {
    // Transition seam from the retired staging/latest channel era: the
    // first build after the rename lands CONTINUES the old staging
    // history instead of minting a disconnected orphan, so every fleet
    // repo's recorded _commit (an old staging build commit) stays
    // reachable through the new branch. Once the old ref is deleted this
    // arm goes dead and can be removed.
    must(["git", "fetch", "--quiet", "origin", "staging"]);
    must(["git", "worktree", "add", "--detach", "/tmp/pub", "origin/staging"]);
  } else {
    must(["git", "worktree", "add", "--detach", "/tmp/pub", sourceSha]);
    must(["git", "-C", "/tmp/pub", "switch", "--orphan", `build-${BRANCH}`]);
  }
  // --checksum: the quick size+mtime check can miss a changed file when
  // both trees were written in the same second and the content is
  // same-size - and every decision below trusts this tree.
  must(["rsync", "-a", "--delete", "--checksum", "--exclude=.git", "/tmp/tree/", "/tmp/pub/"]);
  must(["git", "-C", "/tmp/pub", "add", "-A"]);
  console.log("::endgroup::");
  // A missing branch always publishes: the ref must exist for the sync to
  // resolve, even when the composed tree happens to equal the seed tip's.
  const note =
    capture(["git", "-C", "/tmp/pub", "diff", "--cached", "--quiet"]).exitCode !== 0
      ? "content change"
      : branchExists
        ? restampReason(sourceSha)
        : "branch bootstrap";
  if (note === "") {
    console.log(`${BRANCH}: no content change`);
    return null;
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
  return { branch: BRANCH, dir: "/tmp/pub", note };
}

/** Newest-green-wins (pending.ts owns the rule), gating BOTH branches
 * before EITHER moves: under cancel-in-progress: false a queued publisher
 * can execute after a NEWER main already published, and a stale build
 * must never roll a branch back. Checking only the template tip after
 * already pushing actions - the old shape - let a stale run rewind the
 * executable actions ref and then skip template, leaving the two branches
 * shipping different sources. Either branch's tip being newer than this
 * run's source skips the whole publish. The two branches do NOT always
 * move together - a branch whose content is unchanged stays put while the
 * other advances, so their source stamps can differ - but gating on
 * EITHER being newer is the conservative check that still guarantees a
 * stale run never rolls back the branch that DID advance past it.
 * Loud skip, green run: this is normal operation under concurrent pushes,
 * and the newer tip's own run already delivered the newer trees.
 *
 * Returns the staleness reason ("" when clear) AND the exact remote tip
 * each branch was VALIDATED at (a per-branch snapshot; "" for an absent
 * branch). The push leases against THESE tips, not the ones prepare later
 * re-fetches: a newer publisher racing in between this snapshot and the
 * push moves the ref off the snapshot, the lease fails, and the whole
 * atomic push aborts - closing the window where prepare would otherwise
 * build on (and lease) the newer tip and append this stale run's content
 * on top of it. */
function stalePreflight(sourceSha: string): { stale: string; tips: Map<string, string> } {
  const tips = new Map<string, string>();
  for (const branch of [ACTIONS_BRANCH, BRANCH]) {
    if (!refExistsOnOrigin(`refs/heads/${branch}`)) {
      tips.set(branch, "");
      continue;
    }
    must(["git", "fetch", "--quiet", "origin", branch]);
    tips.set(branch, mustCapture(["git", "rev-parse", `origin/${branch}`]));
    const tipSource = commitStampParse(
      mustCapture(["git", "log", "-1", "--format=%B", `origin/${branch}`]),
    );
    const stale = staleReason(
      sourceSha,
      tipSource,
      (ancestor, descendant) =>
        resolves(`${ancestor}^{commit}`) !== "" &&
        resolves(`${descendant}^{commit}`) !== "" &&
        isAncestor(ancestor, descendant),
    );
    if (stale !== "") return { stale: `${branch}: ${stale}`, tips };
  }
  return { stale: "", tips };
}

/** One push, atomic across both refs AND check-and-set on each. Every
 * EXISTING delivery branch the preflight validated goes into the
 * transaction, leased against the tip the preflight saw: a CHANGED branch
 * pushes its prepared commit, an UNCHANGED-but-existing branch pushes its
 * own preflight tip (a no-op update whose only job is to carry the lease).
 * So a concurrent publisher that advanced EITHER branch since the
 * preflight - even the one this run left unchanged - moves it off the
 * leased tip, fails the lease, and aborts the WHOLE atomic push. Without
 * the no-op guard this run could land its (older) source on the branch it
 * changed while the other branch moved ahead, splitting the two delivery
 * branches across different sources. The lease is pure CAS: every real
 * update is a fast-forward when its lease holds (the prepared commit is a
 * child of the leased tip); a "" lease (bootstrap) requires the ref to
 * still not exist. An absent, unchanged branch is neither pushed nor
 * guarded - there is nothing to protect. */
function pushPrepared(prepared: PreparedBranch[], preflightTips: Map<string, string>): void {
  if (prepared.length === 0) return;
  const preparedByBranch = new Map(prepared.map((entry) => [entry.branch, entry]));
  const leases: string[] = [];
  const refspecs: string[] = [];
  for (const branch of [ACTIONS_BRANCH, BRANCH]) {
    const tip = preflightTips.get(branch) ?? "";
    const entry = preparedByBranch.get(branch);
    if (entry !== undefined) {
      const head = mustCapture(["git", "-C", entry.dir, "rev-parse", "HEAD"]);
      leases.push(`--force-with-lease=refs/heads/${branch}:${tip}`);
      refspecs.push(`${head}:refs/heads/${branch}`);
    } else if (tip !== "") {
      leases.push(`--force-with-lease=refs/heads/${branch}:${tip}`);
      refspecs.push(`${tip}:refs/heads/${branch}`);
    }
  }
  must(["git", "push", "--atomic", ...leases, "origin", ...refspecs]);
  for (const branch of prepared) {
    const short = mustCapture(["git", "-C", branch.dir, "rev-parse", "--short", "HEAD"]);
    console.log(`${branch.branch}: pushed ${short} (${branch.note})`);
  }
}

/** Delete pending refs this publish consumed or obsoleted: the candidate's
 * own ref, and every pending ref whose source is an ancestor of the
 * candidate (a newer tree covers them; their queued publishers will skip
 * as stale anyway). Pending refs for NEWER sources stay - their own
 * publishers still need them. Best-effort: a failed delete warns, never
 * reds the run (the refs are per-sha, so leftovers cannot corrupt). */
function sweepPendingRefs(sourceSha: string): void {
  const listing = capture(["git", "ls-remote", "origin", `${PENDING_REF_PREFIX}*`]);
  if (listing.exitCode !== 0) {
    console.log("::warning::could not list pending build refs; skipping the sweep");
    return;
  }
  for (const line of listing.stdout.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref === undefined || !ref.startsWith(PENDING_REF_PREFIX)) continue;
    const refSource = ref.slice(PENDING_REF_PREFIX.length);
    const consumed =
      refSource === sourceSha ||
      (resolves(`${refSource}^{commit}`) !== "" && isAncestor(refSource, sourceSha));
    if (!consumed) continue;
    const deleted = capture(["git", "push", "--quiet", "origin", "--delete", ref]);
    if (deleted.exitCode !== 0) {
      console.log(`::warning::could not delete consumed pending ref ${ref}`);
    } else {
      console.log(`swept pending ref ${ref}`);
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
// and API paths reach here with no such proof - and the branches ship only
// commits whose all-green gate succeeded. Enforced on the commit actually
// being published (SOURCE_SHA, the same commit the stamp records).
const notGreen = allGreenFailure(repository, sourceSha);
if (notGreen !== null) {
  fail(
    `refusing to publish the build branches: main commit ${sourceSha.slice(0, 12)} is not green - ${notGreen}. The branches only ship green main commits; get CI to a successful run on main's tip, then re-run.`,
  );
}
// The newest-green preflight gates BOTH branches before EITHER is
// prepared or pushed; the prepared commits then land in one atomic push
// (actions listed first: a fresh template render pins @actions, so the
// ref its pins resolve against advances in the same stroke, never after).
const { stale, tips } = stalePreflight(sourceSha);
if (stale !== "") {
  console.log(`skipping publish - ${stale}`);
} else {
  const prepared = [prepareActionsBranch(sourceSha), prepareTemplateBranch(sourceSha)].filter(
    (branch): branch is PreparedBranch => branch !== null,
  );
  pushPrepared(prepared, tips);
}
sweepPendingRefs(sourceSha);
