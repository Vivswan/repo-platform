// The build-publish wiring the provenance path depends on, pinned where a
// silent edit would reintroduce the regression: the publisher's SOURCE_SHA
// must track the COMPLETED CI run's head_sha (not github.sha, which is
// main's current tip on a workflow_run event), and the three enforcement
// points must agree on the publish-step name AND both provenance checks
// must actually read the run's jobs to verify it.

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

  test("the publish step name is one string across the workflow and both provenance checks", () => {
    // publish.ts's re-stamp check and verify_build_provenance.ts both prove
    // a stamped run PUBLISHED by requiring this exact step to have
    // succeeded (conclusion=success alone is a red main's no-op). If the
    // workflow renamed the step, both proofs would reject every run (no
    // step of that name ever succeeds), stranding the fleet.
    expect(workflow).toContain("- name: Build and publish");
    const publish = read(".github/scripts/build-branches/publish.ts");
    const verify = read(".github/scripts/sync/verify_build_provenance.ts");
    expect(publish).toContain('const PUBLISH_STEP = "Build and publish"');
    expect(verify).toContain('const PUBLISH_STEP = "Build and publish"');
    // Both must actually READ the run's jobs - the step-success proof is
    // worthless if a future refactor drops the jobs read. Match the API
    // PATH (a template literal ending .../jobs), not the "runs/jobs
    // response" diagnostic label, which would survive the cut.
    const jobsApiCall = /actions\/runs\/\$\{[^}]+\}\/jobs`/;
    expect(publish).toMatch(jobsApiCall);
    expect(verify).toMatch(jobsApiCall);
  });
});
