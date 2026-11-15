// The bun block of the auto-format starter, run as the label would run it. What would drift silently: biome exits
// non-zero when a finding has no safe fix, after writing the formatting, and a failed step skips the starter's commit
// step, so the pull request gets a red job and no formatting commit while the uv block's pull request gets its commit.
//
// The fixture is synthetic: one line biome reformats, and one assignment in a condition, which biome reports and
// never rewrites.

import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

interface Step {
  name?: string;
  run?: string;
  "continue-on-error"?: boolean;
}

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../..");
const BUN_FILES = join(REPO_ROOT, "files/bun");
const UNFORMATTED = 'let x = 1;\nif ((x = 2)) {\nconsole.log(   "a"   )\n}\nexport { x };\n';
const FORMATTED = 'let x = 1;\nif ((x = 2)) {\n\tconsole.log("a");\n}\n\nexport { x };\n';

test("a pull request with formatting to apply beside a finding biome cannot fix still reaches the commit step, formatted", () => {
  const steps = parseYaml(
    readFileSync(join(BUN_FILES, ".github/workflows/auto-format.toolchain.yml"), "utf-8"),
  ) as Step[];
  const format = steps.find((step) => step.name === "Format (biome)");
  const biomeArgs = /^bun x @biomejs\/biome@\S+ (.+)$/.exec(format?.run ?? "")?.[1].split(" ");
  const checkout = temp.dir("auto-format-block-");
  for (const name of ["biome.json", "biome.local.jsonc"]) {
    writeFileSync(join(checkout, name), readFileSync(join(BUN_FILES, name)));
  }
  writeFileSync(join(checkout, "a.js"), UNFORMATTED);

  // The root's biome is the starter's: tests/files/biome_floor.test.ts holds the two versions equal.
  const biome = boundedSpawnSync(
    ["bun", join(REPO_ROOT, "node_modules/.bin/biome"), ...(biomeArgs ?? [])],
    { cwd: checkout, timeoutMs: 60_000 },
  );

  // GitHub's step rule: a later step with no status function runs only when every step before it succeeded or
  // carried continue-on-error.
  expect({
    biomeFailed: biome.exitCode !== 0,
    file: readFileSync(join(checkout, "a.js"), "utf-8"),
    commitStepRuns: biome.exitCode === 0 || format?.["continue-on-error"] === true,
  }).toEqual({ biomeFailed: true, file: FORMATTED, commitStepRuns: true });
});
