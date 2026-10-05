// GitHub evaluates expressions in action metadata at load time; a `${{ toJSON(steps) }}` in an input description failed every consumer's standard-checks job at load.

import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Action, loadAction, REPO_ROOT } from "../shared/action_step";

const ACTIONS_DIR = join(REPO_ROOT, "actions");
const ACTION_NAMES = readdirSync(ACTIONS_DIR)
  .filter((name) => existsSync(join(ACTIONS_DIR, name, "action.yml")))
  .sort();

function metadataProblems(action: Action): string[] {
  const prose: [string, unknown][] = [
    ["name", action.name],
    ["description", action.description],
    ...Object.entries(action.inputs ?? {}).map(([key, spec]): [string, unknown] => [
      `inputs.${key}.description`,
      spec.description,
    ]),
    ...Object.entries(action.outputs ?? {}).map(([key, spec]): [string, unknown] => [
      `outputs.${key}.description`,
      spec.description,
    ]),
  ];
  return prose
    .filter(([, text]) => typeof text === "string" && text.includes("${{"))
    .map(([where]) => `${where} holds an expression delimiter`);
}

const CONTROL_ACTION: Action = {
  name: "control",
  description: "the control",
  inputs: { steps: { description: "pass ${{ toJSON(steps) }}", required: true } },
  outputs: { path: { description: "the path", value: "${{ steps.first.outputs.path }}" } },
  runs: { using: "composite", steps: [] },
};

test("no action's name, description, or input and output descriptions hold an expression delimiter", () => {
  const judged = Object.fromEntries(
    ACTION_NAMES.map((name) => [name, metadataProblems(loadAction(`actions/${name}/action.yml`))]),
  );
  expect(judged).toEqual(Object.fromEntries(ACTION_NAMES.map((name) => [name, []])));
  expect(metadataProblems(CONTROL_ACTION)).toEqual([
    "inputs.steps.description holds an expression delimiter",
  ]);
});
