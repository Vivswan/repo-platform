// The bun module ships the TypeScript lint floor as a managed biome.json over a repo-owned biome.local.jsonc starter.
// What would drift silently: an entry gone or misclassed in files.yml (the fleet keeps an old floor, green), a biome
// version moving in one of its homes (the gate's biome and the formatter's disagree, green).
//
// The root copy is not pinned here: this repository syncs itself after a merge, so a PR that changes the shipped file
// stays green until that sync writes the root. The writer runs over the real files.yml with every upstream file a stub.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncReport } from "../../.github/scripts/sync/writer/report.ts";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";
import { spawnStubUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const FILES_TREE = join(REPO_ROOT, "files");
const SHIPPED_FLOOR = readFileSync(join(FILES_TREE, "bun/biome.json"), "utf-8");
const SHIPPED_LOCAL = readFileSync(join(FILES_TREE, "bun/biome.local.jsonc"), "utf-8");
const LOCAL_EDIT = '// edited by the repository\n{ "formatter": { "lineWidth": 100 } }\n';

const upstream = await spawnStubUpstream(
  parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8")),
  temp.dir("biome-floor-upstream-"),
);
afterAll(() => upstream.stop());

function registered(label: string, modules: string[]): string {
  const target = temp.dir(`biome-floor-${label}-`);
  writeFileSync(
    join(target, ".repo-platform.yml"),
    `modules: ${JSON.stringify(modules)}\nproject:\n  name: Demo\n  slug: demo\n  description: A demo\n`,
  );
  return target;
}

/** The two paths' rows as `path: change`, from the `--summary` JSON: the Markdown report is for a reader, and its
 *  layout may move. */
function sync(target: string): string[] {
  const summary = join(temp.dir("biome-floor-summary-"), "summary.json");
  const result = boundedSpawnSync(
    [
      "bun",
      SYNC,
      "--files",
      join(REPO_ROOT, "files.yml"),
      "--tree",
      FILES_TREE,
      "--target",
      target,
      "--build",
      "0".repeat(40),
      "--repository",
      "owner/demo",
      "--private",
      "false",
      "--upstream",
      upstream.host,
      "--summary",
      summary,
    ],
    { cwd: REPO_ROOT, timeoutMs: 60_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(readFileSync(summary, "utf-8")) as SyncReport;
  return report.written
    .filter((row) => row.path === "biome.json" || row.path === "biome.local.jsonc")
    .map((row) => `${row.path}: ${row.change}`);
}

const landed = (target: string, name: string): string | null =>
  existsSync(join(target, name)) ? readFileSync(join(target, name), "utf-8") : null;

describe("the shipped biome pair", () => {
  test("selecting bun lands the managed floor byte-equal to the shipped file and the starter beside it; no module lands neither", () => {
    const bun = registered("bun", ["bun"]);
    const none = registered("none", []);
    expect({
      rows: sync(bun),
      floor: landed(bun, "biome.json"),
      local: landed(bun, "biome.local.jsonc"),
    }).toEqual({
      rows: ["biome.json: created", "biome.local.jsonc: created"],
      floor: SHIPPED_FLOOR,
      local: SHIPPED_LOCAL,
    });
    expect({
      rows: sync(none),
      floor: landed(none, "biome.json"),
      local: landed(none, "biome.local.jsonc"),
    }).toEqual({
      rows: [],
      floor: null,
      local: null,
    });
  });

  test("a second sync leaves the repository's edited local layer alone and finds the floor unchanged", () => {
    const target = registered("resync", ["bun"]);
    sync(target);
    writeFileSync(join(target, "biome.local.jsonc"), LOCAL_EDIT);
    expect({ rows: sync(target), local: landed(target, "biome.local.jsonc") }).toEqual({
      rows: ["biome.json: unchanged", "biome.local.jsonc: unchanged"],
      local: LOCAL_EDIT,
    });
  });
});

describe("one biome version", () => {
  const dependency = (manifest: string, field: "dependencies" | "devDependencies"): string =>
    (
      JSON.parse(readFileSync(join(REPO_ROOT, manifest), "utf-8")) as Record<
        string,
        Record<string, string>
      >
    )[field]["@biomejs/biome"];
  const schemaVersion = (text: string): string | undefined =>
    /^https:\/\/biomejs\.dev\/schemas\/(.+)\/schema\.json$/.exec(
      (JSON.parse(text) as { $schema: string }).$schema,
    )?.[1];
  const starterVersion = (): string | undefined =>
    /bun x @biomejs\/biome@(\S+) check --write \./.exec(
      readFileSync(join(FILES_TREE, "bun/.github/workflows/auto-format.toolchain.yml"), "utf-8"),
    )?.[1];

  // The root biome.json's $schema is not compared: a managed root copy follows the shipped file by self-sync.
  test("the action's dependency, the root devDependency, the shipped $schema URL, and the auto-format starter name one version", () => {
    const pinned = dependency("actions/biome/package.json", "dependencies");
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect({
      root: dependency("package.json", "devDependencies"),
      shippedSchema: schemaVersion(SHIPPED_FLOOR),
      starter: starterVersion(),
    }).toEqual({ root: pinned, shippedSchema: pinned, starter: pinned });
  });
});
