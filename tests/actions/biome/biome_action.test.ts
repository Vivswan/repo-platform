// The shipped floor (files/bun/biome.json, the bytes every bun repository lints under) keeps its merge semantics at the
// biome the action pins: `extends` loads the local layer first and the managed file applies last, `linter.rules`
// deep-merges so a local addition lands beneath the floor, and a local `overrides` entry still scopes a rule off by
// path. A floor edit or a biome bump that changed any of these would let a repository lower the floor, green. The step
// runs as the manifest spells it, under node, over a scratch checkout holding the shipped bytes.

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

/** The floor as the sync ships it: no vcs block, so no .git is needed. */
const MANAGED = readFileSync(join(REPO_ROOT, "files/bun/biome.json"), "utf8");

/** Fails noParameterAssign on its first line, and logs (for the noConsole row). */
const ASSIGNS_PARAM =
  "export function f(n: number): number {\n  n = n + 1;\n  console.log(n);\n  return n;\n}\n";

/** The same function through a local, as the floor wants; it still logs. */
const LOCAL_COPY =
  "export function f(n: number): number {\n  const m = n + 1;\n  console.log(m);\n  return m;\n}\n";

/** Clean under the whole floor. */
const CLEAN = "export function f(x: boolean): boolean {\n  return !x;\n}\n";

function fixture(local: string, files: Record<string, string>): string {
  const repo = temp.dir("biome-fixture-");
  writeFileSync(join(repo, "biome.json"), MANAGED);
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
    row: "(a) an empty local layer: a parameter assignment fails naming lint/style/noParameterAssign",
    local: "{}",
    files: { "src/a.ts": ASSIGNS_PARAM },
    exitCode: 1,
    named: ["lint/style/noParameterAssign"],
  },
  {
    row: "(b) a local addition (suspicious/noConsole) applies beneath the floor: both fire, so linter.rules deep-merges",
    local: '{"linter": {"rules": {"suspicious": {"noConsole": "error"}}}}',
    files: { "src/a.ts": ASSIGNS_PARAM },
    exitCode: 1,
    named: ["lint/style/noParameterAssign", "lint/suspicious/noConsole"],
  },
  {
    row: "(c) a local layer turning noParameterAssign off at the top level does not lower the floor: the managed file applies last",
    local: '{"linter": {"rules": {"style": {"noParameterAssign": "off"}}}}',
    files: { "src/a.ts": ASSIGNS_PARAM },
    exitCode: 1,
    named: ["lint/style/noParameterAssign"],
  },
  {
    row: "(d) a local override for legacy/** turns the rule off there and nowhere else",
    local:
      '{"overrides": [{"includes": ["legacy/**"], "linter": {"rules": {"style": {"noParameterAssign": "off"}}}}]}',
    files: { "legacy/old.ts": ASSIGNS_PARAM, "src/a.ts": ASSIGNS_PARAM },
    exitCode: 1,
    named: ["src/a.ts", "lint/style/noParameterAssign"],
    unnamed: ["legacy/old.ts"],
  },
  {
    row: "(d, the control) the same override with the floor-clean file outside legacy/ passes",
    local:
      '{"overrides": [{"includes": ["legacy/**"], "linter": {"rules": {"style": {"noParameterAssign": "off"}}}}]}',
    files: { "legacy/old.ts": ASSIGNS_PARAM, "src/a.ts": LOCAL_COPY },
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
