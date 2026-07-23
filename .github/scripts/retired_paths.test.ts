import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { listRenderPaths, readSkipIfExists, retiredPaths } from "./retired_paths";

function makeRender(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "render-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

describe("retiredPaths", () => {
  const oldPaths = new Set([
    ".github/workflows/ci.yml",
    ".github/workflows/template-sync.yml",
    ".github/workflows/checks.yml",
    "README.md",
  ]);
  const newPaths = new Set([".github/workflows/ci.yml", "README.md"]);

  test("a path in the old render but not the new one is a candidate", () => {
    expect(retiredPaths(oldPaths, newPaths, [".github/workflows/checks.yml"])).toEqual([
      ".github/workflows/template-sync.yml",
    ]);
  });

  test("a path in both renders is never a candidate", () => {
    expect(retiredPaths(oldPaths, newPaths, [])).not.toContain("README.md");
  });

  test("the protected settings.yml never appears even when de-rendered", () => {
    const withSettings = new Set([...oldPaths, ".github/settings.yml"]);
    expect(retiredPaths(withSettings, newPaths, [])).not.toContain(".github/settings.yml");
  });

  test("a file outside both renders never appears (repo-owned by construction)", () => {
    const candidates = retiredPaths(oldPaths, newPaths, []);
    expect(candidates).not.toContain("src/index.ts");
    for (const path of candidates) {
      expect(oldPaths.has(path)).toBe(true);
    }
  });

  test("a _skip_if_exists path from the OLD version's list never appears", () => {
    const skip = [".github/workflows/template-sync.yml"];
    expect(retiredPaths(oldPaths, newPaths, skip)).toEqual([".github/workflows/checks.yml"]);
  });

  test("a _skip_if_exists path from the NEW version's list never appears", () => {
    // The union of both lists protects a file even when only one version
    // declares it generated-once.
    const oldSkip: string[] = [];
    const newSkip = [".github/workflows/checks.yml", ".github/workflows/template-sync.yml"];
    expect(retiredPaths(oldPaths, newPaths, [...oldSkip, ...newSkip])).toEqual([]);
  });

  test("glob-shaped skip patterns match", () => {
    expect(retiredPaths(oldPaths, newPaths, [".github/workflows/*.yml"])).toEqual([]);
  });

  test("output is sorted", () => {
    const candidates = retiredPaths(oldPaths, newPaths, []);
    expect(candidates).toEqual([...candidates].sort());
  });
});

describe("listRenderPaths", () => {
  test("walks nested files and includes symlinks without following them", () => {
    const root = makeRender({
      "README.md": "hi",
      ".github/workflows/ci.yml": "name: CI",
    });
    symlinkSync("README.md", join(root, "CLAUDE.md"));
    expect(listRenderPaths(root)).toEqual(
      new Set(["README.md", ".github/workflows/ci.yml", "CLAUDE.md"]),
    );
  });

  test("ignores .git", () => {
    const root = makeRender({ "a.txt": "a", ".git/config": "x" });
    expect(listRenderPaths(root)).toEqual(new Set(["a.txt"]));
  });

  test("a symlink retired between renders becomes a candidate", () => {
    const oldRoot = makeRender({ "AGENTS.md": "agents" });
    symlinkSync("AGENTS.md", join(oldRoot, "copilot.md"));
    const newRoot = makeRender({ "AGENTS.md": "agents" });
    expect(retiredPaths(listRenderPaths(oldRoot), listRenderPaths(newRoot), [])).toEqual([
      "copilot.md",
    ]);
  });
});

describe("readSkipIfExists", () => {
  test("reads the list", () => {
    const { patterns, errors } = readSkipIfExists(
      parse("_skip_if_exists:\n  - .github/workflows/checks.yml\n  - release-please-config.json"),
    );
    expect(errors).toEqual([]);
    expect(patterns).toEqual([".github/workflows/checks.yml", "release-please-config.json"]);
  });

  test("absent list means no patterns", () => {
    const { patterns, errors } = readSkipIfExists(parse("_subdirectory: template"));
    expect(errors).toEqual([]);
    expect(patterns).toEqual([]);
  });

  test("fails on a malformed list", () => {
    const { patterns, errors } = readSkipIfExists(parse("_skip_if_exists: nope"));
    expect(patterns).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
