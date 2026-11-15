// Octokit is installed in actions/github-client alone, so a second importer resolves it on a developer's machine (a
// hoisted copy) and nowhere on a runner; an action that spawns gh instead has no retry and no reply schema. The linter
// owns both rules (biome.local.jsonc); this file keeps that each bites.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lintFixture } from "../shared/biome_fixture.ts";
import { tempDirs } from "../shared/temp_dir.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GH_SPAWN_PLUGIN = "./biome/gh_spawn.grit";
const GH_SPAWN_MESSAGE = "never a spawned gh";

const temp = tempDirs();

const OCTOKIT_REACHED_THREE_WAYS = [
  'import { Octokit } from "@octokit/core";',
  'import type { RequestError } from "@octokit/request-error";',
  'const lazy = await import("@octokit/plugin-retry");',
  'import { z } from "zod";',
  'const prose = "the client wraps @octokit/core";',
  "export const all = [Octokit, lazy, z, prose] as RequestError[];",
  "",
].join("\n");

/** Where a plugin rule fired on `files`, as `path:line`. */
function pluginDiagnostics(files: Record<string, string>): string[] {
  return lintFixture(temp.dir("github-client-zone-lint-"), files)
    .filter((d) => d.category === "plugin")
    .map((d) => `${d.path}:${d.line}`)
    .sort();
}

// Drifts silently without this: an edit to the block (its globs, the plugin's pattern) leaves every real file green,
// because none of them imports octokit today.
test("the linter reds an octokit import everywhere but in the client's package", () => {
  const seen = pluginDiagnostics({
    "actions/github-client/x.ts": OCTOKIT_REACHED_THREE_WAYS,
    "actions/other/x.ts": OCTOKIT_REACHED_THREE_WAYS,
    ".github/scripts/x.ts": OCTOKIT_REACHED_THREE_WAYS,
    "scripts/x.ts": OCTOKIT_REACHED_THREE_WAYS,
    "tests/x.ts": OCTOKIT_REACHED_THREE_WAYS,
  });

  expect(seen).toEqual(
    [".github/scripts/x.ts", "actions/other/x.ts", "scripts/x.ts", "tests/x.ts"]
      .flatMap((path) => [1, 2, 3].map((line) => `${path}:${line}`))
      .sort(),
  );
});

// Drifts silently without this: an edit to the block leaves every real action green, because the ones that still spawn
// gh are the block's own exclusions.
test("the linter reds a spawned gh in an action, and nowhere else", () => {
  const spawn = [
    'const view = capture(["gh", "api", "repos/o/r"], { timeoutMs: 1 });',
    "const head = 'gh';",
    'const prose = "gh is not spawned here";',
    "export const all = [view, head, prose];",
    "",
  ].join("\n");

  const seen = pluginDiagnostics({
    "actions/other/x.ts": spawn,
    "actions/github-client/x.ts": spawn,
    ".github/scripts/x.ts": spawn,
    "tests/x.ts": spawn,
  });

  expect(seen).toEqual([
    "actions/github-client/x.ts:1",
    "actions/github-client/x.ts:2",
    "actions/other/x.ts:1",
    "actions/other/x.ts:2",
  ]);
});

// Drifts silently without this: an action that stops spawning gh keeps its exclusion, so a gh spawned there later is
// never judged.
test("every file the gh rule excludes still spawns gh", () => {
  const config = Bun.JSONC.parse(readFileSync(join(REPO_ROOT, "biome.local.jsonc"), "utf-8")) as {
    overrides: { includes: string[]; plugins?: string[] }[];
  };
  const block = config.overrides.find((override) => override.plugins?.includes(GH_SPAWN_PLUGIN));
  if (block === undefined) throw new Error(`no override runs ${GH_SPAWN_PLUGIN}`);

  const exclusions = block.includes.filter((glob) => glob.startsWith("!"));

  // Under lifted/ no exclusion matches, so the rule judges the real content; a file that is gone is judged empty.
  const lifted = (exclusion: string): string => `actions/lifted/${exclusion.slice(1)}`;
  const content = (exclusion: string): string => {
    const file = join(REPO_ROOT, exclusion.slice(1));

    return existsSync(file) ? readFileSync(file, "utf-8") : "";
  };
  const spawning = new Set(
    lintFixture(
      temp.dir("github-client-zone-lint-"),
      Object.fromEntries(exclusions.map((exclusion) => [lifted(exclusion), content(exclusion)])),
    )
      .filter((d) => d.message.includes(GH_SPAWN_MESSAGE))
      .map((d) => d.path),
  );

  const staleLines = exclusions.filter((exclusion) => !spawning.has(lifted(exclusion)));

  expect(staleLines).toEqual([]);
});
