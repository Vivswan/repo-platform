import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleBranchTree,
  canonicalize,
  copyActions,
  destOverlapsRepo,
  EXCLUDED_DIRS,
} from "../../.github/scripts/build-branches/branch_tree";

const REPO = "/home/user/repo-platform";

describe("destOverlapsRepo", () => {
  test("rejects the repository root itself", () => {
    expect(destOverlapsRepo(REPO, REPO)).toBe(true);
  });

  test("rejects every ancestor of the repository, including the filesystem root", () => {
    for (const dest of ["/", "/home", "/home/user"]) {
      expect(destOverlapsRepo(dest, REPO)).toBe(true);
    }
  });

  test("rejects paths inside the repository", () => {
    expect(destOverlapsRepo(`${REPO}/template`, REPO)).toBe(true);
  });

  test("accepts unrelated paths, including siblings sharing a name prefix", () => {
    for (const dest of ["/tmp/build-tree", "/home/user/repo-platform-scratch", "/home/other"]) {
      expect(destOverlapsRepo(dest, REPO)).toBe(false);
    }
  });
});

describe("canonicalize", () => {
  test("dereferences a symlinked parent so an alias of the repo still overlaps", () => {
    const root = mkdtempSync(join(tmpdir(), "bt-"));
    const repo = join(root, "real", "repo");
    mkdirSync(repo, { recursive: true });
    symlinkSync(join(root, "real"), join(root, "alias"));
    const aliased = canonicalize(join(root, "alias", "repo"));
    expect(destOverlapsRepo(aliased, canonicalize(repo))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("re-attaches a not-yet-existing tail unresolved", () => {
    const root = mkdtempSync(join(tmpdir(), "bt-"));
    expect(canonicalize(join(root, "no", "such", "dir"))).toBe(
      join(canonicalize(root), "no", "such", "dir"),
    );
    rmSync(root, { recursive: true, force: true });
  });
});

// The actions/ subtree of the build branch is what lets a fleet repository
// pin an action @build instead of @main. What ships is source and the
// dependency manifests plus nothing else: node_modules is excluded (each
// action installs at its own action_path when it runs), and publishing
// FAILS LOUDLY when there is nothing to publish - a build branch missing
// actions/ would 404 every fleet CI run, which is a far worse way to find
// out.
function actionsFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "branch-actions-"));
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
    const root = actionsFixture();
    const dest = mkdtempSync(join(tmpdir(), "branch-actions-dest-"));
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

  test("refuses a tree with no actions at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "branch-actions-empty-"));
    const dest = mkdtempSync(join(tmpdir(), "branch-actions-dest-"));
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

describe("assembleBranchTree", () => {
  // One real assembly shared by the layout and extraction-safety tests
  // (compose runs once; the tree is read-only afterwards).
  const dest = mkdtempSync(join(tmpdir(), "branch-tree-real-"));
  assembleBranchTree(dest);

  test("the branch root carries exactly the unified layout", () => {
    expect(readdirSync(dest).sort()).toEqual([
      "README.md",
      "actions",
      "copier.yml",
      "stamp_manifest.ts",
      "template",
    ]);
  });

  test("no assembled path carries a jinja expression (tarball extraction safety)", () => {
    // THE invariant that lets one branch serve both copier and `uses:`
    // refs: a uses: ref downloads the whole branch tarball, and
    // extraction dies on path segments like
    // "{% if 'agents' in modules %}CLAUDE.md{% endif %}". The WHOLE real
    // tree is the input here - template/ included, which is exactly the
    // part the retired split-branch design existed to keep out. All
    // three jinja delimiters count: a {# comment #} or {{ var }} segment
    // is just as unextractable as a {% if %} gate.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() && !entry.isSymbolicLink() ? [path, ...walk(path)] : [path];
      });
    const offenders = walk(dest).filter((path) =>
      ["{%", "{{", "{#"].some((delimiter) => path.includes(delimiter)),
    );
    expect(offenders).toEqual([]);
  });

  test("every symlink on the branch resolves inside the tree (no dangling links)", () => {
    // The runner's tarball staging dies on a DANGLING symlink anywhere in
    // the downloaded tree, so branch links keep their .jinja targets (the
    // rendered repo gets the stripped target from the stamp hook).
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) return [path];
        return entry.isDirectory() ? walk(path) : [];
      });
    const dangling = walk(dest).filter((path) => !existsSync(path));
    expect(dangling).toEqual([]);
  });

  test("the composed copier tree and the actions both ship", () => {
    expect(existsSync(join(dest, "template", "AGENTS.md.jinja"))).toBe(true);
    expect(existsSync(join(dest, "actions", "check-typography", "action.yml"))).toBe(true);
    expect(existsSync(join(dest, "actions", "check-typography", "node_modules"))).toBe(false);
  });
});
