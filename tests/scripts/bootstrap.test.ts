// The bootstrap's discovery, pinned two ways: the live tree's whole list
// (an action gaining or dropping a bun.lock moves it), and a planted tree
// whose controls are a directory without a bun.lock, a bun.lock under
// node_modules, and a nested lock directory.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunLockDirs, missingNodeModules } from "../../scripts/bootstrap";
import { tempDirs } from "../shared/temp_dir";

const root = join(import.meta.dir, "../..");
const temp = tempDirs();

function plant(base: string, path: string, files: string[]): void {
  mkdirSync(join(base, path), { recursive: true });
  for (const file of files) writeFileSync(join(base, path, file), "");
}

describe("bunLockDirs", () => {
  test("the live tree: the root plus every action committing a bun.lock", () => {
    expect(bunLockDirs(root)).toEqual([
      ".",
      "actions/check-file-size",
      "actions/check-typography",
      "actions/dedupe-bun-lockfile",
      "actions/fuzz-issue",
      "actions/pages-site",
      "actions/plan",
      "actions/release-health",
      "actions/trivy",
      "actions/validate-commit-names",
      "actions/validate-managed-files",
      "actions/validate-skills",
    ]);
  });

  test("a planted tree: no lock, a lock under node_modules, a nested lock", () => {
    const base = temp.dir("bootstrap-discovery-");
    plant(base, "actions/with-lock", ["bun.lock", "package.json"]);
    plant(base, "actions/with-lock/node_modules/dep", ["bun.lock"]);
    plant(base, "actions/without-lock", ["package.json"]);
    plant(base, "actions/parent/nested", ["bun.lock"]);

    const dirs = bunLockDirs(base);
    expect(dirs).toEqual(["actions/parent/nested", "actions/with-lock"]);
    expect(missingNodeModules(base, dirs)).toEqual(["actions/parent/nested"]);

    writeFileSync(join(base, "bun.lock"), "");
    expect(bunLockDirs(base)).toEqual([".", "actions/parent/nested", "actions/with-lock"]);
  });
});
