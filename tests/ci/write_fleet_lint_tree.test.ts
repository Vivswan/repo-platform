import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";
import { spawnStubUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(REPO_ROOT, ".github/scripts/ci/write_fleet_lint_tree.ts");
// The lint reads workflows, so every upstream file is a stub and never the network.
const FILES = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const upstream = await spawnStubUpstream(FILES, temp.dir("fleet-lint-upstream-"));
afterAll(() => upstream.stop());

describe("write_fleet_lint_tree.ts", () => {
  test("lands the all-modules and no-module selections as git roots, every workflow parseable and placeholder-free", () => {
    // ci.yml's actionlint job lints these trees one step later: a selection dropped goes unlinted, green; a
    // target that is not a git root makes actionlint skip the project's .github/actionlint.yaml.
    const dest = temp.dir("fleet-lint-");
    const run = boundedSpawnSync([process.execPath, SCRIPT, dest, "--upstream", upstream.host], {
      cwd: REPO_ROOT,
    });
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
    const stdout = run.stdout.toString();
    expect(stdout).toContain("all: ");
    expect(stdout).toContain("none: ");
    const landed: Record<string, string[]> = {};
    for (const name of ["all", "none"]) {
      const dir = join(dest, name, ".github/workflows");
      const workflows = readdirSync(dir).filter((file) => file.endsWith(".yml"));
      expect(workflows).toContain("ci.yml");
      for (const file of workflows) {
        const text = readFileSync(join(dir, file), "utf-8");
        expect(text).not.toMatch(/(?<!\$)\{\{/);
        expect(() => parseYaml(text)).not.toThrow();
      }
      landed[name] = workflows;
    }
    // The registrations the script wrote: all of files.yml's modules, and none; a module left out of `all`
    // leaves its workflows unlinted while both trees still lint.
    const registered = (name: string) =>
      (
        parseYaml(readFileSync(join(dest, name, ".repo-platform.yml"), "utf-8")) as {
          modules: string[];
        }
      ).modules;
    expect(registered("all")).toEqual(Object.keys(FILES.modules));
    expect(registered("none")).toEqual([]);
    // The all tree lands the module workflows over the base ones; two equal trees lint one selection twice.
    expect(landed.none.filter((file) => !landed.all.includes(file))).toEqual([]);
    expect(landed.all.length).toBeGreaterThan(landed.none.length);
    for (const name of ["all", "none"]) {
      expect(existsSync(join(dest, name, ".git"))).toBe(true);
      expect(existsSync(join(dest, name, ".github/actionlint.yaml"))).toBe(true);
    }
  });
});
