import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionManifestPaths } from "../../../scripts/lib/action_steps.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const MANIFEST = "runs:\n  steps:\n    - run: echo ok\n";

test("actionManifestPaths lists every action.yml and action.yaml, nested ones included, sorted; symlinks, other files, and unpublished directories are not manifests", () => {
  const dir = temp.dir("action-manifests-");
  mkdirSync(join(dir, "pages-site", "check-links"), { recursive: true });
  writeFileSync(join(dir, "pages-site", "action.yml"), MANIFEST);
  writeFileSync(join(dir, "pages-site", "check-links", "action.yml"), MANIFEST);
  writeFileSync(join(dir, "pages-site", "site.ts"), "export {};\n");
  mkdirSync(join(dir, "spelled-long"));
  writeFileSync(join(dir, "spelled-long", "action.yaml"), MANIFEST);
  mkdirSync(join(dir, "pages-site", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "pages-site", "node_modules", "dep", "action.yml"), MANIFEST);
  mkdirSync(join(dir, "shared"));
  symlinkSync(join(dir, "pages-site", "action.yml"), join(dir, "shared", "action.yml"));
  mkdirSync(join(dir, "x"));
  writeFileSync(join(dir, "x", "not-action.yml"), MANIFEST);
  symlinkSync(join(dir, "spelled-long"), join(dir, "linked-dir"));
  expect(actionManifestPaths(dir)).toEqual([
    "actions/pages-site/action.yml",
    "actions/pages-site/check-links/action.yml",
    "actions/spelled-long/action.yaml",
  ]);
});
