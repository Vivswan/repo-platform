// The tree of the `actions` build branch, which is what lets a fleet
// repository pin an action @actions instead of @main - on a branch whose
// tarball EXTRACTS: `uses:` downloads the whole branch, and the composed
// template tree's jinja-expression filenames kill extraction before any
// step runs, so this tree must never carry one.
//
// Three properties matter and all are pinned here: what ships (source and
// dependency manifests plus the README, never node_modules, which each
// action reinstalls at its own action_path), that NO published path
// carries a jinja expression (the extraction-safety regression), and that
// publishing FAILS LOUDLY when there is nothing to publish - an actions
// branch missing actions/ would 404 every fleet CI run, which is a far
// worse way to find out.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ACTIONS_README,
  buildActionsTree,
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

  test("refuses a directory with sources but no action.yml, naming it", () => {
    // Broken state, not a retirement: retiring an action deletes its whole
    // directory. Publishing sources without a manifest would succeed here
    // and then 404 every fleet `uses: .../<name>@actions` at resolve time.
    const root = fixture();
    const orphan = join(root, "actions", "orphaned-action");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "runtime.ts"), "export {};\n");
    const dest = mkdtempSync(join(tmpdir(), "publish-actions-dest-"));
    expect(() => copyActions(root, dest)).toThrow("actions/orphaned-action");
    expect(() => copyActions(root, dest)).toThrow("no action.yml");
  });

  test("node_modules is excluded by name, wherever it sits", () => {
    expect(EXCLUDED_DIRS.has("node_modules")).toBe(true);
  });
});

describe("buildActionsTree", () => {
  test("ships actions/ plus the README and nothing else", () => {
    const root = fixture();
    const dest = mkdtempSync(join(tmpdir(), "actions-tree-"));
    const files = buildActionsTree(root, dest);
    expect(files).toBe(4);
    expect(existsSync(join(dest, "actions", "check-typography", "action.yml"))).toBe(true);
    expect(existsSync(join(dest, "README.md"))).toBe(true);
    expect(readdirSync(dest).sort()).toEqual(["README.md", "actions"]);
  });

  test("no published path carries a jinja expression (tarball extraction safety)", () => {
    // THE reason this branch exists: `uses: ...@ref` downloads the whole
    // branch tarball, and extraction dies on filenames like
    // "{% if 'agents' in modules %}CLAUDE.md{% endif %}". The real
    // actions/ tree is the input here, so a jinja-named file sneaking
    // into any action fails this before it breaks the fleet.
    const repoRoot = join(import.meta.dir, "..", "..");
    const dest = mkdtempSync(join(tmpdir(), "actions-tree-real-"));
    buildActionsTree(repoRoot, dest);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? [path, ...walk(path)] : [path];
      });
    const offenders = walk(dest).filter((path) => path.includes("{%") || path.includes("{{"));
    expect(offenders).toEqual([]);
  });
});

describe("the README's auto-close claim", () => {
  test("protect-build-branches.yml really closes PRs targeting the actions branch", () => {
    // The generated README promises PRs against the branch "are closed
    // automatically"; that is only true while the protect workflow's
    // job condition covers the actions ref, so the claim and the
    // condition are pinned together (exact equality - a contains-check
    // would stay green on a mangled condition).
    expect(ACTIONS_README).toContain("closed\nautomatically");
    const workflow = parseYaml(
      readFileSync(
        join(import.meta.dir, "../../.github/workflows/protect-build-branches.yml"),
        "utf8",
      ),
    ) as { jobs: { close: { if: string } } };
    expect(workflow.jobs.close.if).toBe(
      'contains(fromJSON(\'["template", "actions"]\'), github.event.pull_request.base.ref)',
    );
  });
});
