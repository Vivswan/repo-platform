// The shared Pages deploy's job split: the config job plans (the plan
// action's bun must never reach the PATH caller build commands run on, so
// the action runs in its own job), the deploy job builds the commit config
// read, and the link-rot job keys on config's label. Each property here is
// one a refactor could lose while the deploy still works on a happy path.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  steps?: Step[];
}

const source = readFileSync(
  join(import.meta.dir, "../../.github/workflows/reusable-pages.yml"),
  "utf8",
);
const workflow = parseYaml(source) as {
  on: { workflow_call: { inputs: Record<string, { required?: boolean; default?: unknown }> } };
  jobs: Record<string, Job>;
};
const PLAN_ACTION = "repo-platform/actions/plan@build";
const CONFIG_OUTPUTS = [
  "mounts",
  "setup",
  "install_command",
  "build_command",
  "dist_dir",
  "site_title",
  "docs_dir",
  "link_rot_label",
];
const usesOf = (job: Job | undefined) => (job?.steps ?? []).map((step) => step.uses ?? "run");

describe("reusable-pages.yml", () => {
  test("config is the first job: a sparse checkout at the deploy's ref, then the plan action in pages mode with every caller input", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["config", "deploy", "link-rot"]);
    const job = workflow.jobs.config;
    const steps = job?.steps ?? [];
    expect(usesOf(job)).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining(PLAN_ACTION),
    ]);
    expect(steps[0]?.id).toBe("checkout");
    expect(steps[0]?.with).toEqual({
      "ref":
        "${{ inputs.sha || (github.event_name == 'push' && github.sha || github.event.repository.default_branch) }}",
      "sparse-checkout": ".repo-platform.yml\n",
      "sparse-checkout-cone-mode": false,
    });
    expect(steps[1]?.id).toBe("plan");
    expect(steps[1]?.with).toEqual({
      mode: "pages",
      ...Object.fromEntries(CONFIG_OUTPUTS.map((name) => [name, `\${{ inputs.${name} }}`])),
    });
    // The commit it read, plus every resolved value, as job outputs.
    expect(job?.outputs).toEqual({
      sha: "${{ steps.checkout.outputs.commit }}",
      ...Object.fromEntries(
        CONFIG_OUTPUTS.map((name) => [name, `\${{ steps.plan.outputs.${name} }}`]),
      ),
    });
  });

  test("deploy needs config, builds the commit config read, and runs no plan action itself", () => {
    const job = workflow.jobs.deploy;
    expect(job?.needs).toBe("config");
    const checkout = (job?.steps ?? []).find((step) =>
      (step.uses ?? "").includes("actions/checkout@"),
    );
    expect(checkout?.with).toEqual({ "fetch-depth": 0, "ref": "${{ needs.config.outputs.sha }}" });
    // The negative control for the PATH isolation: the plan action appears
    // in config only, so its bun-setup cannot precede the caller's build.
    expect(usesOf(job).filter((uses) => uses.includes(PLAN_ACTION))).toEqual([]);
    expect(usesOf(workflow.jobs.config).filter((uses) => uses.includes(PLAN_ACTION))).toHaveLength(
      1,
    );
    // Every configured value the site build consumes comes from config.
    const site = (job?.steps ?? []).find((step) =>
      (step.uses ?? "").includes("actions/pages-site@build"),
    );
    for (const name of [
      "mounts",
      "install_command",
      "build_command",
      "dist_dir",
      "site_title",
      "docs_dir",
    ]) {
      expect(JSON.stringify(site?.with)).toContain(`\${{ needs.config.outputs.${name} }}`);
    }
    const deployText = source.slice(source.indexOf("\n  deploy:"));
    expect(deployText).not.toContain("inputs.mounts");
    expect(deployText).not.toContain("inputs.setup");
  });

  test("the toolchain setup steps gate on the resolving step's positive per-tool outputs", () => {
    const steps = workflow.jobs.deploy?.steps ?? [];
    const tools = steps.find((step) => step.id === "tools");
    expect(tools?.env).toEqual({ SETUP: "${{ needs.config.outputs.setup }}" });
    const gated = steps.filter((step) =>
      /^steps\.tools\.outputs\.[a-z]+ == 'true'$/.test(step.if ?? ""),
    );
    expect(gated.map((step) => step.if)).toEqual([
      "steps.tools.outputs.bun == 'true'",
      "steps.tools.outputs.bun == 'true'",
      "steps.tools.outputs.node == 'true'",
      "steps.tools.outputs.deno == 'true'",
      "steps.tools.outputs.uv == 'true'",
      "steps.tools.outputs.rust == 'true'",
      "steps.tools.outputs.rust == 'true'",
    ]);
  });

  test("link-rot keys on config's label and needs both jobs", () => {
    const job = workflow.jobs["link-rot"];
    expect(job?.needs).toEqual(["config", "deploy"]);
    expect(job?.if).toBe(
      "github.event_name == 'schedule' && needs.config.outputs.link_rot_label != ''",
    );
    const labels = (job?.steps ?? [])
      .filter((step) => (step.uses ?? "").includes("actions/fuzz-issue@build"))
      .map((step) => step.with?.label);
    expect(labels).toEqual([
      "${{ needs.config.outputs.link_rot_label }}",
      "${{ needs.config.outputs.link_rot_label }}",
    ]);
  });

  test("every input is optional: a caller passing mounts configures itself, one passing none gets the plan", () => {
    for (const [name, input] of Object.entries(workflow.on.workflow_call.inputs)) {
      expect([name, input.required]).toEqual([name, false]);
    }
    expect(workflow.on.workflow_call.inputs.mounts?.default).toBe("");
  });
});
