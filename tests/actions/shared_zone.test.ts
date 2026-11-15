// actions/shared runs from the delivery commit before any install: only the running action's node_modules exist on a
// runner, so a zone module reaches node builtins and its own siblings. The linter owns the import rule (the
// actions/shared block in biome.local.jsonc), the typecheck refuses a `node:` name that is no builtin, and this file
// keeps what neither can see: the folder's shape, and that the linter's block still bites.

import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn.ts";
import { tempDirs } from "../shared/temp_dir.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SHARED = join(REPO_ROOT, "actions", "shared");
const temp = tempDirs();

test("actions/shared holds only TypeScript modules: a manifest or node_modules would make it install-shaped, a test file would ship and import bun:test", () => {
  const strays = readdirSync(SHARED).filter(
    (name) => !name.endsWith(".ts") || name.endsWith(".test.ts"),
  );

  expect(strays).toEqual([]);
});

// Drifts silently without this: an edit to the zone block (its glob, a pattern, a dropped plugin line) leaves every
// real zone file green, because none of them offends today.
test("the linter reds each way out of the zone, in the zone only, and passes each accepted form", () => {
  const lintRoot = temp.dir("shared-zone-lint-");
  const source = [
    'import { readFileSync } from "node:fs";',
    'import { readFile } from "node:fs/promises";',
    'import { createRequire } from "node:module";',
    'import { peer } from "./peer.ts";',
    'import { z } from "zod";',
    'import { core } from "@actions/core";',
    'import { join } from "path";',
    'import { up } from "../outside.ts";',
    'import { deep } from "./nested/deep.ts";',
    'import type { Only } from "zod";',
    'const lazy = await import(/* c */ "./later.ts");',
    "const computed = await import(String(peer));",
    'const old = require("node:fs");',
    "const require = createRequire(import.meta.url);",
    'const viaCast = (require as NodeJS.Require)(String("zod"));',
    'const text = "import(";',
    "export const all = [readFileSync, readFile, z, core, join, up, deep, lazy, computed, old, viaCast, text] as Only[];",
    "",
  ].join("\n");
  const files: Record<string, string> = {
    "biome.json": readFileSync(join(REPO_ROOT, "biome.json"), "utf-8"),
    "biome.local.jsonc": readFileSync(join(REPO_ROOT, "biome.local.jsonc"), "utf-8"),
    ...Object.fromEntries(
      readdirSync(join(REPO_ROOT, "biome")).map((name) => [
        `biome/${name}`,
        readFileSync(join(REPO_ROOT, "biome", name), "utf-8"),
      ]),
    ),
    "actions/shared/x.ts": source,
    "actions/other/x.ts": source,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(lintRoot, rel)), { recursive: true });
    writeFileSync(join(lintRoot, rel), content);
  }

  const r = boundedSpawnSync(
    [
      join(REPO_ROOT, "node_modules", ".bin", "biome"),
      "lint",
      "--reporter=json",
      "--vcs-enabled=false",
      ".",
    ],
    { cwd: lintRoot },
  );
  const report = JSON.parse(r.stdout) as {
    diagnostics: { category: string; location: { path: string; start: { line: number } } }[];
  };
  const zoneRules = new Set(["lint/style/noRestrictedImports", "plugin"]);
  const seen = report.diagnostics
    .filter((d) => zoneRules.has(d.category))
    .map((d) => `${d.location.path}:${d.location.start.line} ${d.category}`)
    .sort();

  expect(seen).toEqual(
    [
      "actions/shared/x.ts:5 lint/style/noRestrictedImports",
      "actions/shared/x.ts:6 lint/style/noRestrictedImports",
      "actions/shared/x.ts:7 lint/style/noRestrictedImports",
      "actions/shared/x.ts:8 lint/style/noRestrictedImports",
      "actions/shared/x.ts:9 lint/style/noRestrictedImports",
      "actions/shared/x.ts:10 lint/style/noRestrictedImports",
      "actions/shared/x.ts:11 plugin",
      "actions/shared/x.ts:12 plugin",
      "actions/shared/x.ts:13 plugin",
      "actions/shared/x.ts:15 plugin",
    ].sort(),
  );
});
