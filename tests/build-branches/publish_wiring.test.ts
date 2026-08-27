// The build-publish wiring the provenance path depends on, pinned where a
// silent edit would reintroduce the regression: the publisher's SOURCE_SHA
// must track the COMPLETED CI run's head_sha (not github.sha, which is
// main's current tip on a workflow_run event), the enforcement points
// must agree on the publish-step name AND every provenance check must
// actually read the run's jobs to verify it, and a template no-op must
// publish its marker (or the sync-side wait burns out on every no-op).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("build-branches publish wiring", () => {
  const workflow = read(".github/workflows/build-branches.yml");

  test("SOURCE_SHA and PREBUILT_REF key off workflow_run.head_sha, not github.sha", () => {
    // On a workflow_run event github.sha is main's CURRENT tip, not the
    // commit whose CI completed - so a green A superseded by red B would
    // never publish. Both must derive from the event's head_sha, falling
    // back to github.sha only off the workflow_run path (schedule/dispatch,
    // where github.sha IS the trigger commit).
    expect(workflow).toContain(
      "SOURCE_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}",
    );
    expect(workflow).toContain(
      "PREBUILT_REF: ${{ github.event_name == 'workflow_run' && format('refs/build-pending/{0}', github.event.workflow_run.head_sha) || '' }}",
    );
  });

  test("the publish step name is one string across the workflow and all three provenance checks", () => {
    // publish.ts's re-stamp check, verify_build_provenance.ts, and
    // wait_for_build.ts's marker battery all prove a stamped run PUBLISHED
    // by requiring this exact step to have succeeded (conclusion=success
    // alone is a red main's no-op). If the workflow renamed the step, the
    // proofs would reject every run (no step of that name ever succeeds),
    // stranding the fleet.
    expect(workflow).toContain("- name: Build and publish");
    const publish = read(".github/scripts/build-branches/publish.ts");
    const verify = read(".github/scripts/sync/verify_build_provenance.ts");
    const wait = read(".github/scripts/sync/wait_for_build.ts");
    expect(publish).toContain('const PUBLISH_STEP = "Build and publish"');
    expect(verify).toContain('const PUBLISH_STEP = "Build and publish"');
    expect(wait).toContain('const PUBLISH_STEP = "Build and publish"');
    // All must actually READ the run's jobs - the step-success proof is
    // worthless if a future refactor drops the jobs read. Match the API
    // PATH (a template literal ending .../jobs), not the "runs/jobs
    // response" diagnostic label, which would survive the cut.
    const jobsApiCall = /actions\/runs\/\$\{[^}]+\}\/jobs`/;
    expect(publish).toMatch(jobsApiCall);
    expect(verify).toMatch(jobsApiCall);
    expect(wait).toMatch(jobsApiCall);
  });

  test("a build no-op records marker + claim, after the publish call, force, and only then", () => {
    // The stamp only advances on a content change, so without the marker
    // a no-op source leaves wait_for_build.ts burning its whole wait on
    // every later sync (the next build is also a no-op - the cron cannot
    // heal it). Pinned: the marker publishes only on the verified-no-op
    // outcome publish() returns - a "published" outcome carries the fresh
    // stamp itself and a stale skip has nothing to record (a FULL no-op
    // has nothing to lease; its marker is inert through the tip binding);
    // the push is forced (successive markers do not descend from each
    // other, so a rerun must overwrite, not fail as a non-fast-forward);
    // and the claim is handed to the workflow's artifact step, whose
    // upload binds it to the run - the run-owned evidence the waiter's
    // battery requires. The sweep keeps the marker it just pushed
    // ("keep") while pendings stay consumed ("consume").
    const publish = read(".github/scripts/build-branches/publish.ts");
    const publishIndex = publish.indexOf("const outcome = publish(sourceSha);");
    const markIndex = publish.indexOf('if (outcome.kind === "noop") {');
    expect(publishIndex).toBeGreaterThan(0);
    expect(markIndex).toBeGreaterThan(publishIndex);
    expect(publish).toContain("publishNoopMarker(sourceSha, outcome.tipSha);");
    expect(publish).toMatch(/"--force",\s*"origin",\s*`\$\{marker\}:\$\{ref\}`/);
    expect(publish).toContain('setOutput("noop_claim", claim);');
    expect(publish).toContain('sweepSourceRefs(PENDING_REF_PREFIX, sourceSha, "consume");');
    expect(publish).toContain('sweepSourceRefs(NOOP_MARKER_REF_PREFIX, sourceSha, "keep");');
    // The workflow side of the claim: the artifact NAME is the claim, the
    // step runs only when publish.ts made one, and the file it uploads is
    // the one publish.ts wrote.
    expect(workflow).toContain("id: publish");
    expect(workflow).toContain("if: steps.publish.outputs.noop_claim != ''");
    expect(workflow).toContain("name: ${{ steps.publish.outputs.noop_claim }}");
    expect(workflow).toContain("path: /tmp/noop-claim.txt");
    expect(publish).toContain('writeFileSync("/tmp/noop-claim.txt"');
  });
});
