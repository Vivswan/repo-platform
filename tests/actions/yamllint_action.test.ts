// The fleet relies on exactly two steps: the pinned pip install and the strict lint (-s: warnings fail too) of the whole checkout.
// A loosened flag or a narrowed path is a deliberate edit here.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(import.meta.dir, "../..");
const ACTION_YML = join(REPO_ROOT, "actions/yamllint/action.yml");
const PIN_FILE = "actions/yamllint/requirements.txt";

interface Step {
  shell?: string;
  run?: string;
}

describe("the yamllint action", () => {
  const action = () => parseYaml(readFileSync(ACTION_YML, "utf8"));

  test("a composite of exactly the pinned install and the strict lint, with no inputs to loosen it", () => {
    const parsed = action();
    expect(parsed.runs.using).toBe("composite");
    const steps: Step[] = parsed.runs.steps;
    expect(steps.map((step) => step.run)).toEqual([
      'python3 -m pip install --quiet --requirement "$GITHUB_ACTION_PATH/requirements.txt"',
      "yamllint -s .",
    ]);
    for (const step of steps) expect(step.shell).toBe("bash");
    // No inputs: every fleet repo lints the same way.
    expect(parsed.inputs).toBeUndefined();
  });

  // One version literal: the pin file is the only home, and the local lint script reads the same file.
  test("the pin file holds exactly one pinned yamllint and the lint:yaml script installs from it", () => {
    expect(readFileSync(join(REPO_ROOT, PIN_FILE), "utf8")).toMatch(/^yamllint==\d+\.\d+\.\d+\n$/);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["lint:yaml"]).toBe(`uvx --with-requirements ${PIN_FILE} yamllint -s .`);
  });
});
