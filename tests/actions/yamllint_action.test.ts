// The yamllint action's contract: the content assertions that left the
// smoke harness when the fleet ci.yml job became a thin caller. What the
// fleet relies on is exactly two steps - the pip install and the STRICT
// lint (-s: warnings fail too) of the caller's whole checkout - so a
// loosened flag or a narrowed path is a deliberate edit here, not a quiet
// render change.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ACTION_YML = join(import.meta.dir, "../../actions/yamllint/action.yml");

interface Step {
  shell?: string;
  run?: string;
}

describe("the yamllint action", () => {
  const action = () => parseYaml(readFileSync(ACTION_YML, "utf8"));

  test("a composite of exactly the install and the strict lint, with no inputs to loosen it", () => {
    const parsed = action();
    expect(parsed.runs.using).toBe("composite");
    const steps: Step[] = parsed.runs.steps;
    expect(steps.map((step) => step.run)).toEqual([
      "python3 -m pip install --quiet yamllint",
      "yamllint -s .",
    ]);
    for (const step of steps) expect(step.shell).toBe("bash");
    // No inputs: every fleet repo lints the same way.
    expect(parsed.inputs).toBeUndefined();
  });
});
