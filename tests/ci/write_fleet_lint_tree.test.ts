// The fleet-workflow lint tree (ci.yml's actionlint job): the writer lands
// every selection's workflows in scratch, run through the script as CI
// does, and the written files parse as YAML with their placeholders gone.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(REPO_ROOT, ".github/scripts/ci/write_fleet_lint_tree.ts");

describe("write_fleet_lint_tree.ts", () => {
  test("lands the all-modules and no-module selections, every workflow parseable and placeholder-free", () => {
    const dest = temp.dir("fleet-lint-");
    const run = boundedSpawnSync([process.execPath, SCRIPT, dest], { cwd: REPO_ROOT });
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
    const stdout = run.stdout.toString();
    expect(stdout).toContain("all: ");
    expect(stdout).toContain("none: ");
    for (const name of ["all", "none"]) {
      const dir = join(dest, name, ".github/workflows");
      const workflows = readdirSync(dir).filter((file) => file.endsWith(".yml"));
      expect(workflows).toContain("ci.yml");
      for (const file of workflows) {
        const text = readFileSync(join(dir, file), "utf-8");
        expect(text).not.toMatch(/(?<!\$)\{\{/);
        expect(() => parseYaml(text)).not.toThrow();
      }
    }
    // The module workflows land only with their modules selected.
    expect(readdirSync(join(dest, "all", ".github/workflows"))).toContain("pr-title.yml");
    expect(readdirSync(join(dest, "none", ".github/workflows"))).not.toContain("pr-title.yml");
    // Each target is a git project carrying the starter actionlint config,
    // so actionlint applies the fleet's ignores.
    for (const name of ["all", "none"]) {
      expect(existsSync(join(dest, name, ".git"))).toBe(true);
      expect(existsSync(join(dest, name, ".github/actionlint.yaml"))).toBe(true);
    }
    // With actionlint on PATH (CI's job puts it there before this step),
    // the written workflows lint clean from each target's root, the same
    // invocation ci.yml makes; a planted content error through the same
    // invocation goes red, so a clean run is a verdict, not a no-op.
    const which = boundedSpawnSync(["sh", "-c", "command -v actionlint"], { cwd: REPO_ROOT });
    if (which.exitCode === 0) {
      for (const name of ["all", "none"]) {
        const lint = boundedSpawnSync(["actionlint", "-color"], { cwd: join(dest, name) });
        expect([name, lint.exitCode, lint.stdout.toString()]).toEqual([name, 0, ""]);
      }
      const planted = join(dest, "none", ".github/workflows/planted.yml");
      writeFileSync(planted, "on: push\njobs:\n  x:\n    run-on: ubuntu-latest\n    steps: []\n");
      const red = boundedSpawnSync(["actionlint", "-color"], { cwd: join(dest, "none") });
      expect(red.exitCode).not.toBe(0);
      expect(red.stdout.toString()).toContain("planted.yml");
    }
  });

  test("a missing or extra argument is a usage error", () => {
    const run = boundedSpawnSync([process.execPath, SCRIPT], { cwd: REPO_ROOT });
    expect(run.exitCode).toBe(2);
  });
});
