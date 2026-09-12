import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT } from "../../shared/action_step";

const action = loadAction("actions/knip/action.yml");

describe("actions/knip", () => {
  test("a composite of exactly the pinned knip run on knip's own defaults: no inputs, no config, no env", () => {
    expect(action.runs.using).toBe("composite");
    expect(action.inputs).toBeUndefined();
    expect(action.runs.steps).toHaveLength(1);
    const [run] = action.runs.steps;
    expect(run.env).toBeUndefined();
    // npx, not a bun runner: the caller's toolchain may be node alone.
    expect(String(run.run).trim()).toMatch(/^npx --yes knip@\d+\.\d+\.\d+$/);
  });

  test("the fleet runs the knip this repository tests with", () => {
    const [run] = action.runs.steps;
    const pinned = /knip@(\d+\.\d+\.\d+)/.exec(String(run.run))?.[1];
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pinned).toBe(pkg.devDependencies.knip);
  });
});
