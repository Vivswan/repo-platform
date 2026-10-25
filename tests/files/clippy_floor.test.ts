// A clippy.toml threshold is dead without its lint in the Cargo.toml table, and
// a wiring slip in files.yml lands neither file: the writer over the real
// files.yml lands both for the rust module, with the header's placeholder
// rendered, and nothing without it.

import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";
import { spawnStubUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const FILES_TREE = join(REPO_ROOT, "files");
const BUILD = "0".repeat(40);

// This test reads the two rust files alone, so every upstream file is a stub and never the network.
const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const upstream = await spawnStubUpstream(config, temp.dir("clippy-floor-upstream-"));
afterAll(() => upstream.stop());

interface LintTables {
  workspace: { lints: { clippy: Record<string, string> } };
}

function synced(label: string, modules: string[]): string {
  const target = temp.dir(`clippy-floor-${label}-`);
  writeFileSync(
    join(target, ".repo-platform.yml"),
    [
      `modules: ${JSON.stringify(modules)}`,
      "project:",
      "  name: Demo",
      "  slug: demo",
      "  description: A demo",
      "  copyright_holder: Owner",
      "",
    ].join("\n"),
  );
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
      BUILD,
      "--repository",
      "owner/demo",
      "--private",
      "false",
      "--upstream",
      upstream.host,
    ],
    { cwd: REPO_ROOT, timeoutMs: 60_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return target;
}

test("the rust module lands clippy.toml with its header rendered, and every threshold names a denied lint", () => {
  const target = synced("rust", ["rust"]);
  const clippyToml = readFileSync(join(target, "clippy.toml"), "utf-8");
  expect(clippyToml.split("\n")[0]).toBe("# This file is managed by owner/repo-platform.");

  const thresholds = Bun.TOML.parse(clippyToml) as Record<string, number>;
  const cargo = Bun.TOML.parse(readFileSync(join(target, "Cargo.toml"), "utf-8")) as LintTables;
  const denied = cargo.workspace.lints.clippy;
  const thresholdLints = Object.keys(thresholds).map((key) =>
    key.replace(/-threshold$/, "").replaceAll("-", "_"),
  );
  expect(thresholdLints.length).toBeGreaterThan(0);
  for (const lint of thresholdLints) {
    expect(denied[lint]).toBe("deny");
  }
});

test("without the rust module neither file lands", () => {
  const target = synced("none", []);
  expect(existsSync(join(target, "clippy.toml"))).toBe(false);
  expect(existsSync(join(target, "Cargo.toml"))).toBe(false);
});
