// The fleet squash-merges with the PR title as the subject, and the subject then meets actions/validate-commit-names;
// the pr-title check runs that same action on the title, so no title it passes can land red at the commit-names gate.
// The root twin is judged too: nothing else pins it to the managed source.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_OWNER, PLATFORM_SLUG } from "../../actions/shared/platform.ts";
import { DELIVERY_REF } from "../../scripts/check/ssot/delivery_pins.ts";

interface Workflow {
  on: unknown;
  permissions: unknown;
  jobs: Record<string, { steps: unknown[] }>;
}

// The managed source spells the owner as the writer's placeholder; rendered, the two twins are one workflow.
function rendered(workflowPath: string): Workflow {
  const source = readFileSync(join(import.meta.dir, "../..", workflowPath), "utf8");
  return parseYaml(source.replaceAll("{{github_username}}", PLATFORM_OWNER)) as Workflow;
}

describe.each([
  ["files/pr-title/.github/workflows/pr-title.yml"],
  [".github/workflows/pr-title.yml"],
])("%s judges the title with the commit-names action", (workflowPath) => {
  test("one job, one step: the action at the delivery ref, fed the PR title, no token", () => {
    const workflow = rendered(workflowPath);
    expect([workflow.on, workflow.permissions, Object.keys(workflow.jobs)]).toEqual([
      { pull_request: { types: ["opened", "edited", "reopened", "synchronize"] } },
      {},
      ["pr-title"],
    ]);
    expect(workflow.jobs["pr-title"].steps).toEqual([
      {
        uses: `${PLATFORM_SLUG}/actions/validate-commit-names@${DELIVERY_REF}`,
        with: { title: "${{ github.event.pull_request.title }}" },
      },
    ]);
  });
});
