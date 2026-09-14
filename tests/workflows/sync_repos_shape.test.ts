import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// The manifest records the build as the commit the repository is judged against (docs/sync.md, The manifest), so the
// code that writes the tree must be the build's, not the operator checkout's: a stable-tag lag would otherwise stamp a
// commit whose writer never ran.

const WORKFLOW = join(import.meta.dir, "../../.github/workflows/sync-repos.yml");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
}

describe("sync-repos.yml runs the build's writer", () => {
  const steps = (
    parseYaml(readFileSync(WORKFLOW, "utf-8")) as { jobs: { sync: { steps: Step[] } } }
  ).jobs.sync.steps;
  const write = steps.find((step) => step.name === "Write the build into the target");

  test("the build's dependencies are installed under build/ after its checkout and before the writer", () => {
    const names = steps.map((step) => step.name ?? step.uses ?? "");
    const checkout = names.indexOf("Check out the build");
    const install = names.indexOf("Install the build's dependencies");
    const write = names.indexOf("Write the build into the target");
    expect(checkout).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(checkout);
    expect(write).toBeGreaterThan(install);
    const words = (steps[install].run ?? "").split(/\s+/);
    expect(words.slice(0, 2)).toEqual(["bun", "install"]);
    expect(words).toContain("--frozen-lockfile");
    expect(words[words.indexOf("--cwd") + 1]).toBe("build");
  });

  test("the migrations step drives build/'s rungs with build/'s migrate.ts", () => {
    const migrate = steps.find((step) => step.name === "Run the migrations over the target");
    const words = (migrate?.run ?? "").split(/\s+/);
    expect(words.slice(0, 3)).toEqual([
      "bun",
      "build/.github/scripts/sync/migrate.ts",
      "build/migrations",
    ]);
  });

  test("the writer step invokes sync.ts from build/ over build/'s data", () => {
    expect(write?.run).toBeDefined();
    const words = (write?.run ?? "").split(/\s+/);
    expect(words.slice(0, 2)).toEqual(["bun", "build/.github/scripts/sync/writer/sync.ts"]);
    for (const flag of ["--files", "--tree"]) {
      expect(words[words.indexOf(flag) + 1]).toStartWith("build/");
    }
  });
});
