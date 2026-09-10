// The knip action's contract: the repository's own configuration is
// discovered by knip itself and the fleet default only fills the gap, and
// the run is the pinned knip over that flag alone.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/knip/action.yml");

describe("actions/knip", () => {
  test("a composite of the config resolution and the pinned knip run, no inputs to loosen it", () => {
    expect(action.runs.using).toBe("composite");
    expect(action.inputs).toBeUndefined();
    const [resolve, run] = action.runs.steps;
    expect(resolve.id).toBe("config");
    expect(run.env).toEqual({ CONFIG_FLAG: "${{ steps.config.outputs.flag }}" });
    // npx, not a bun runner: the caller's toolchain may be node alone.
    expect(String(run.run).trim()).toMatch(/^npx --yes knip@\d+\.\d+\.\d+ \$CONFIG_FLAG$/);
  });

  const resolveConfig = (repo: string) =>
    runBashStep(stepNamed(action, "Resolve the configuration"), {
      fills: { "${{ github.action_path }}": "/opt/action" },
      cwd: repo,
      root: repo,
    });

  test("resolve: the fleet default when the repository carries no knip configuration", () => {
    const repo = temp.dir("knip-none-");
    writeFileSync(join(repo, "package.json"), '{"name": "x"}');
    const run = resolveConfig(repo);
    expect([run.exitCode, run.outputs]).toEqual([0, { flag: "--config /opt/action/knip.json" }]);
  });

  // knip's own discovery list (KNIP_CONFIG_LOCATIONS in the pinned release)
  // plus the package.json key: each must win, or a repository using it would
  // silently get the fleet default instead of its own entries and ignores.
  const OWN_CONFIGS = [
    "knip.json",
    "knip.jsonc",
    ".knip.json",
    ".knip.jsonc",
    "knip.ts",
    "knip.js",
    "knip.config.ts",
    "knip.config.js",
  ];
  for (const own of OWN_CONFIGS) {
    test(`resolve: the repository's own ${own} wins (knip discovers it; no --config)`, () => {
      const repo = temp.dir("knip-own-");
      writeFileSync(join(repo, own), "");
      const run = resolveConfig(repo);
      expect([run.exitCode, run.outputs]).toEqual([0, { flag: "" }]);
    });
  }

  test("resolve: a knip key in package.json wins; a package.json without one does not", () => {
    const withKey = temp.dir("knip-pkg-");
    writeFileSync(join(withKey, "package.json"), '{"name": "x", "knip": {"entry": ["a.ts"]}}');
    expect(resolveConfig(withKey).outputs).toEqual({ flag: "" });
    const without = temp.dir("knip-pkg-none-");
    writeFileSync(join(without, "package.json"), '{"name": "x"}');
    expect(resolveConfig(without).outputs).toEqual({ flag: "--config /opt/action/knip.json" });
  });

  test("the fleet default is a valid knip configuration that only relaxes same-file exports", () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "actions/knip/knip.json"), "utf8"));
    expect(Object.keys(config).sort()).toEqual(["$schema", "ignoreExportsUsedInFile"]);
    expect(config.ignoreExportsUsedInFile).toBe(true);
  });
});
