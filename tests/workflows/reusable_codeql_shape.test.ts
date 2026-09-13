import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "../shared/action_step";

type Step = { id?: string; uses?: string; with?: Record<string, string> };
const read = (rel: string) => parseYaml(readFileSync(join(REPO_ROOT, rel), "utf8"));
const workflow = read(".github/workflows/reusable-codeql.yml") as {
  on: { workflow_call: { inputs: Record<string, { required?: boolean; type?: string }> } };
  jobs: { analyze: { steps: Step[] } };
};
const caller = read(".github/workflows/fleet-ci.yml") as {
  jobs: { codeql: { uses: string; with: Record<string, string> } };
};

describe("reusable-codeql.yml", () => {
  test("takes the language alone, hands init the language and the suppression pack, and fleet-ci passes only the language", () => {
    expect(workflow.on.workflow_call.inputs).toEqual({
      language: expect.objectContaining({ required: true, type: "string" }),
    });
    const steps = workflow.jobs.analyze.steps;
    expect(steps.map((step) => step.id ?? "")).not.toContain("config");
    const init = steps.find((step) => step.uses?.startsWith("github/codeql-action/init@"));
    expect(init?.with).toEqual({
      languages: "${{ inputs.language }}",
      packs:
        "+codeql/${{ inputs.language == 'javascript-typescript' && 'javascript' || inputs.language }}-queries:AlertSuppression.ql",
    });
    expect(caller.jobs.codeql.uses).toBe("./.github/workflows/reusable-codeql.yml");
    expect(caller.jobs.codeql.with).toEqual({ language: "${{ matrix.language }}" });
  });
});
