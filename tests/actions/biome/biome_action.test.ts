// The managed biome.json pair's merge semantics are biome's, at the version the action pins: `extends` loads the local
// layer first and the managed file applies last, `linter.rules` deep-merges so a local addition lands beneath the
// floor, and a local `overrides` entry still scopes a rule off by path. A bump that changed any of these would let a
// repository lower the floor, green. The step runs as the manifest spells it, under node, over a scratch checkout.

import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadAction, REPO_ROOT, RUNNER_BASH, stepNamed } from "../../shared/action_step";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

/** This file's fixture owner: every scratch checkout below is removed with it. */
const temp = tempDirs();

/** The Lint step as the manifest spells it, run verbatim below. */
const step = stepNamed(loadAction("actions/biome/action.yml"), "Lint");

/** The biome the action pins, read from its manifest so the fixture's schema URL follows the pin. */
const PINNED = (
  JSON.parse(readFileSync(join(REPO_ROOT, "actions/biome/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies["@biomejs/biome"];

/** The managed-style floor, as the fleet's biome.json would carry it: no vcs block, so no .git is needed. */
const MANAGED = {
  $schema: `https://biomejs.dev/schemas/${PINNED}/schema.json`,
  extends: ["./biome.local.jsonc"],
  linter: {
    enabled: true,
    rules: {
      complexity: {
        noExcessiveCognitiveComplexity: { level: "error", options: { maxAllowedComplexity: 15 } },
        noExcessiveLinesPerFunction: { level: "error", options: { maxLines: 80 } },
        useMaxParams: { level: "error", options: { max: 6 } },
      },
      style: {
        noNestedTernary: "error",
        noUselessElse: "error",
        noNegationElse: "error",
        noParameterAssign: "error",
        useBlockStatements: "error",
      },
      suspicious: { noAssignInExpressions: "error", noUnusedExpressions: "error" },
      performance: { noBarrelFile: "error", noReExportAll: "error" },
      correctness: { noInvalidUseBeforeDeclaration: "error" },
    },
  },
};

/** Fails useBlockStatements on its guard, and logs (for the noConsole row). */
const BARE_IF = "export function f(x: boolean): void {\n  if (x) return;\n  console.log(x);\n}\n";

/** The same function with the block the floor wants; it still logs. */
const BLOCKED_IF =
  "export function f(x: boolean): void {\n  if (x) {\n    return;\n  }\n  console.log(x);\n}\n";

/** Clean under the whole floor. */
const CLEAN = "export function f(x: boolean): boolean {\n  return !x;\n}\n";

function fixture(local: string, files: Record<string, string>): string {
  const repo = temp.dir("biome-fixture-");
  writeFileSync(join(repo, "biome.json"), JSON.stringify(MANAGED));
  writeFileSync(join(repo, "biome.local.jsonc"), local);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  return repo;
}

interface Row {
  row: string;
  local: string;
  files: Record<string, string>;
  exitCode: number;
  named: string[];
  unnamed?: string[];
}

test.each<Row>([
  {
    row: "(a) an empty local layer: a bare `if (x) return;` fails naming lint/style/useBlockStatements",
    local: "{}",
    files: { "src/a.ts": BARE_IF },
    exitCode: 1,
    named: ["lint/style/useBlockStatements"],
  },
  {
    row: "(b) a local addition (suspicious/noConsole) applies beneath the floor: both fire, so linter.rules deep-merges",
    local: '{"linter": {"rules": {"suspicious": {"noConsole": "error"}}}}',
    files: { "src/a.ts": BARE_IF },
    exitCode: 1,
    named: ["lint/style/useBlockStatements", "lint/suspicious/noConsole"],
  },
  {
    row: "(c) a local layer turning useBlockStatements off at the top level does not lower the floor: the managed file applies last",
    local: '{"linter": {"rules": {"style": {"useBlockStatements": "off"}}}}',
    files: { "src/a.ts": BARE_IF },
    exitCode: 1,
    named: ["lint/style/useBlockStatements"],
  },
  {
    row: "(d) a local override for legacy/** turns the rule off there and nowhere else",
    local:
      '{"overrides": [{"includes": ["legacy/**"], "linter": {"rules": {"style": {"useBlockStatements": "off"}}}}]}',
    files: { "legacy/old.ts": BARE_IF, "src/a.ts": BARE_IF },
    exitCode: 1,
    named: ["src/a.ts", "lint/style/useBlockStatements"],
    unnamed: ["legacy/old.ts"],
  },
  {
    row: "(d, the control) the same override with the floor-clean file outside legacy/ passes",
    local:
      '{"overrides": [{"includes": ["legacy/**"], "linter": {"rules": {"style": {"useBlockStatements": "off"}}}}]}',
    files: { "legacy/old.ts": BARE_IF, "src/a.ts": BLOCKED_IF },
    exitCode: 0,
    named: [],
  },
  {
    row: "(e) a floor-clean file passes",
    local: "{}",
    files: { "src/a.ts": CLEAN },
    exitCode: 0,
    named: [],
  },
])("$row", ({ local, files, exitCode, named, unnamed }) => {
  const run = boundedSpawnSync([...RUNNER_BASH, String(step.run)], {
    cwd: fixture(local, files),
    timeoutMs: 60_000,
    env: { ...process.env, GITHUB_ACTION_PATH: join(REPO_ROOT, "actions/biome") },
  });
  const text = `${run.stdout}\n${run.stderr}`;
  expect({
    exitCode: run.exitCode,
    named: named.filter((needle) => text.includes(needle)),
    unnamed: (unnamed ?? []).filter((needle) => text.includes(needle)),
  }).toEqual({ exitCode, named, unnamed: [] });
});
