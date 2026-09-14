// The release-cut wiring GitHub reads as literals and never checks: the step order and the job lane. Both drift silently,
// since every run that does run is green.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "../shared/action_step";

interface Step {
  id?: string;
  run?: string;
}
interface Job {
  concurrency?: { group: string };
  steps?: Step[];
}

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");
const job = (
  parseYaml(read(".github/workflows/fleet-release.yml")) as { jobs: Record<string, Job> }
).jobs["release-please"];
// The skeleton's `uses:` lines carry the owner placeholder, which YAML reads as a flow mapping.
const skeleton = parseYaml(
  read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
) as { jobs: Record<string, Job> };

describe("fleet-release.yml's release-please job", () => {
  // release-please's propose phase ABORTS green while a merged PR still wears "autorelease: pending", so the stale-pending
  // guard must run AFTER propose, once release-please's own recovery phase has had its turn (commit 634326366); moved above
  // it, the guard fails every run that the recovery would have healed. The health gate first: its output is what the cut
  // and the propose read.
  test("health, cut, head, propose, then the stale-pending guard: the guard after release-please's recovery phase", () => {
    const label = (step: Step) =>
      step.id ?? ((step.run ?? "").includes("autorelease: pending") ? "stale-pending guard" : "?");
    expect((job.steps ?? []).map(label)).toEqual([
      "health",
      "cut",
      "head",
      "propose",
      "stale-pending guard",
    ]);
  });

  // #205, #207: a shared lane keeps one pending call and cancels the older, so a burst of merges cancelled a release commit's
  // cut: no tag, no red. The called job keys its lane by the judged commit and the skeleton's caller holds none.
  test("the lane is keyed by the judged sha in the called job alone; the skeleton's release job holds no lane", () => {
    expect(job.concurrency?.group).toBe("release-cut-${{ inputs.sha }}");
    expect(skeleton.jobs.release.concurrency).toBeUndefined();
  });
});
