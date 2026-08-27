// The actions/ tree published onto the `template` build branch, which is
// what lets a fleet repository pin an action @template instead of @main.
//
// Two properties matter and both are pinned here: what ships (source and
// dependency manifests, never node_modules, which each action reinstalls at
// its own action_path), and that publishing FAILS LOUDLY when there is
// nothing to publish - a template branch missing actions/ would 404 every
// fleet CI run, which is a far worse way to find out.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyActions,
  EXCLUDED_DIRS,
} from "../../.github/scripts/build-branches/publish_actions.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "publish-actions-"));
  const action = join(root, "actions", "check-typography");
  mkdirSync(join(action, "node_modules", "monaco-editor"), { recursive: true });
  mkdirSync(join(action, "lib"), { recursive: true });
  writeFileSync(join(action, "action.yml"), "name: Check Typography\n");
  writeFileSync(join(action, "package.json"), "{}\n");
  writeFileSync(join(action, "bun.lock"), "\n");
  writeFileSync(join(action, "lib", "helper.ts"), "export {};\n");
  writeFileSync(join(action, "node_modules", "monaco-editor", "index.js"), "module.exports={};\n");
  return root;
}

describe("copyActions", () => {
  test("publishes source and manifests, never installed dependencies", () => {
    const root = fixture();
    const dest = mkdtempSync(join(tmpdir(), "publish-actions-dest-"));
    const files = copyActions(root, dest);

    const published = join(dest, "actions", "check-typography");
    expect(existsSync(join(published, "action.yml"))).toBe(true);
    // The manifests ship because the action installs from them when it runs.
    expect(existsSync(join(published, "package.json"))).toBe(true);
    expect(existsSync(join(published, "bun.lock"))).toBe(true);
    // Nested source survives the filter; only the excluded names are cut.
    expect(existsSync(join(published, "lib", "helper.ts"))).toBe(true);
    expect(existsSync(join(published, "node_modules"))).toBe(false);
    expect(files).toBe(4);
  });

  test("refuses to publish a tree with no actions at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "publish-actions-empty-"));
    const dest = mkdtempSync(join(tmpdir(), "publish-actions-dest-"));
    // No actions/ directory: the checkout is wrong, and shipping anyway
    // would break the fleet rather than this run.
    expect(() => copyActions(empty, dest)).toThrow("no actions/ directory");

    mkdirSync(join(empty, "actions"), { recursive: true });
    expect(() => copyActions(empty, dest)).toThrow("holds no action directories");
  });

  test("node_modules is excluded by name, wherever it sits", () => {
    expect(EXCLUDED_DIRS.has("node_modules")).toBe(true);
  });
});
