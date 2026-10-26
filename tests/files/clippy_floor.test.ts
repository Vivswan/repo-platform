// A clippy.toml threshold is dead without its lint in the Cargo.toml table, and
// a wiring slip in files.yml lands neither file: the writer over the real
// files.yml lands both for the rust module, with the header's placeholder
// rendered, and nothing without it. The test reads the two rust files alone,
// so every upstream file is a stub and never the network.

import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { syncedCheckout } from "../shared/synced_checkout";
import { tempDirs } from "../shared/temp_dir";
import { spawnStubUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const upstream = await spawnStubUpstream(config, temp.dir("clippy-floor-upstream-"));
afterAll(() => upstream.stop());

interface LintTables {
  workspace: { lints: { clippy: Record<string, string> } };
}

const synced = (label: string, modules: string[]) =>
  syncedCheckout({ target: temp.dir(`clippy-floor-${label}-`), upstream: upstream.host, modules });

test("the rust module lands clippy.toml with its header rendered, and every threshold names a lint the floor turns on, at warn", () => {
  const target = synced("rust", ["rust"]);
  const clippyToml = readFileSync(join(target, "clippy.toml"), "utf-8");
  expect(clippyToml.split("\n")[0]).toBe("# This file is managed by owner/repo-platform.");

  const thresholds = Bun.TOML.parse(clippyToml) as Record<string, number>;
  const cargo = Bun.TOML.parse(readFileSync(join(target, "Cargo.toml"), "utf-8")) as LintTables;
  const floor = cargo.workspace.lints.clippy;
  const thresholdLints = Object.keys(thresholds).map((key) =>
    key.replace(/-threshold$/, "").replaceAll("-", "_"),
  );
  expect(thresholdLints.length).toBeGreaterThan(0);
  for (const lint of thresholdLints) {
    expect(floor[lint]).toBe("warn");
  }
});

test("without the rust module neither file lands", () => {
  const target = synced("none", []);
  expect(existsSync(join(target, "clippy.toml"))).toBe(false);
  expect(existsSync(join(target, "Cargo.toml"))).toBe(false);
});
