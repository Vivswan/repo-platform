// The release-cut wiring GitHub reads as literals: step ids, outputs, `if:` strings, and the job lane. Each drift below is silent
// at run time - a renamed id reads as an empty output, which is not 'true', so every run skips the cut.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_SLUG } from "../../actions/shared/platform";
import { type Action, loadAction, REPO_ROOT } from "../shared/action_step";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  concurrency?: { group: string; "cancel-in-progress": boolean };
  steps?: Step[];
}

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");
const releaseWorkflow = parseYaml(read(".github/workflows/fleet-release.yml")) as {
  jobs: Record<string, Job>;
};
const job = releaseWorkflow.jobs["release-please"];
const steps = job.steps ?? [];
// The skeleton's `uses:` lines carry the owner placeholder, which YAML reads as a flow mapping.
const skeleton = parseYaml(
  read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
) as {
  jobs: Record<string, Job>;
};

describe("fleet-release.yml's release-please job", () => {
  test("release-health runs before both release-please steps as step `health` in release mode, the id their conditions read", () => {
    const at = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);
    const health = at(
      (step) => step.uses?.startsWith(`${PLATFORM_SLUG}/actions/release-health@`) === true,
    );
    expect(steps[health]).toMatchObject({ id: "health", with: { mode: "release" } });
    expect(health).toBeLessThan(at((step) => step.id === "cut"));
    expect(health).toBeLessThan(at((step) => step.id === "propose"));
  });

  test("exactly two release-please steps: the cut on release-cut true, the propose on release-cut false (a positive test each, since an absent output passes !=)", () => {
    const releasePlease = steps.filter((step) =>
      step.uses?.startsWith("googleapis/release-please-action@"),
    );
    expect(releasePlease.map((step) => step.id)).toEqual(["cut", "propose"]);
    const [cut, propose] = releasePlease;
    expect(cut.if).toBe("steps.health.outputs.release-cut == 'true'");
    expect(cut.with).toMatchObject({ "skip-github-pull-request": true });
    expect(cut.with).not.toHaveProperty("skip-github-release");
    expect(
      String(propose.if)
        .split("&&")
        .map((clause) => clause.trim()),
    ).toContain("steps.health.outputs.release-cut == 'false'");
    expect(propose.with).toMatchObject({ "skip-github-release": true });
  });

  test("the job holds a lane keyed by the judged commit that never cancels, and the skeleton's caller holds none", () => {
    expect(job.concurrency).toEqual({
      "group": "release-cut-${{ inputs.sha || github.sha }}",
      "cancel-in-progress": false,
    });
    expect(skeleton.jobs.release.concurrency).toBeUndefined();
  });
});

describe("actions/release-health/action.yml", () => {
  test("publishes release-cut from the step `check`, the one running release-health.ts", () => {
    const action: Action = loadAction("actions/release-health/action.yml");
    expect(action.outputs?.["release-cut"]?.value).toBe("${{ steps.check.outputs.release-cut }}");
    const check = action.runs.steps.find((step) => step.id === "check");
    expect(String(check?.run)).toContain("release-health.ts");
  });
});
