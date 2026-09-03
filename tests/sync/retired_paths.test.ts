import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  customLicenseFlipError,
  listRenderPaths,
  readSkipIfExists,
  retiredPaths,
} from "../../.github/scripts/sync/retired_paths";

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
  // Insertion order puts template-sync before checks, so every multi-
  // element expectation below also pins the sorted output.
  const oldPaths = new Set([
    ".github/workflows/ci.yml",
    ".github/workflows/template-sync.yml",
    ".github/workflows/checks.yml",
    "README.md",
  ]);
  const newPaths = new Set([".github/workflows/ci.yml", "README.md"]);
  const WORKFLOWS = [".github/workflows/checks.yml", ".github/workflows/template-sync.yml"];

  test.each([
    {
      reason: "a path in the old render but not the new one is a candidate",
      extraOld: [],
      skip: [".github/workflows/checks.yml"],
      modules: [],
      expected: [".github/workflows/template-sync.yml"],
    },
    {
      reason: "a path in both renders is never a candidate; output is sorted",
      extraOld: [],
      skip: [],
      modules: [],
      expected: WORKFLOWS,
    },
    {
      reason: "the protected settings.yml never appears even when de-rendered",
      extraOld: [".github/settings.yml"],
      skip: [],
      modules: [],
      expected: WORKFLOWS,
    },
    {
      reason: "both license spellings are protected on the custom-license module",
      extraOld: ["LICENSE", "LICENSE.md"],
      skip: [],
      modules: ["custom-license"],
      expected: WORKFLOWS,
    },
    {
      // Without the module the license is template-managed: both
      // spellings are deletable, so the extensionless LICENSE retires
      // across the LICENSE.md rename.
      reason: "a fleet repo's license is deletable in both spellings",
      extraOld: ["LICENSE", "LICENSE.md"],
      skip: [],
      modules: [],
      expected: [...WORKFLOWS, "LICENSE", "LICENSE.md"],
    },
    {
      reason: "module membership is exact, not a substring match",
      extraOld: ["LICENSE"],
      skip: [],
      modules: ["my-custom-license-fork"],
      expected: [...WORKFLOWS, "LICENSE"],
    },
    {
      reason: "a _skip_if_exists path from the OLD version's list never appears",
      extraOld: [],
      skip: [".github/workflows/template-sync.yml"],
      modules: [],
      expected: [".github/workflows/checks.yml"],
    },
    {
      // The union of both lists protects a file even when only one
      // version declares it generated-once.
      reason: "a _skip_if_exists path from the NEW version's list never appears",
      extraOld: [],
      skip: [".github/workflows/checks.yml", ".github/workflows/template-sync.yml"],
      modules: [],
      expected: [],
    },
    {
      reason: "glob-shaped skip patterns match",
      extraOld: [],
      skip: [".github/workflows/*.yml"],
      modules: [],
      expected: [],
    },
    {
      // The shared matcher (scripts/ownership.ts) reproduces copier's
      // semantics; the old Bun.Glob here anchored bare names to the root
      // and would have deleted a nested generated-once file copier skips.
      reason: "a bare-name skip pattern protects at any depth (copier's gitwildmatch)",
      extraOld: ["sub/dir/.gitleaks.toml"],
      skip: [".gitleaks.toml"],
      modules: [],
      expected: WORKFLOWS,
    },
  ])("$reason", ({ extraOld, skip, modules, expected }) => {
    expect(retiredPaths(new Set([...oldPaths, ...extraOld]), newPaths, skip, modules)).toEqual(
      expected,
    );
  });

  test("gitwildmatch features beyond the shared subset fail closed, never guess", () => {
    // A guessed match could either delete a repo-owned starter or leave a
    // retired file undead - and disagree with the composer's reading of
    // the same pattern.
    expect(() => retiredPaths(oldPaths, newPaths, ["docs/**"], [])).toThrow(/gitwildmatch/);
  });
});

describe("customLicenseFlipError", () => {
  const flipMessage = (leftover: string) =>
    `this update drops the custom-license module, but ${leftover} from ` +
    "the custom-license era still exists in the repo; the fleet LICENSE.md would land beside " +
    "license terms the sync cannot reconcile. Delete the old license in the same commit that " +
    "removes the module from .repo-platform.yml (git history remains the record of prior " +
    "licensing; third-party notices can move below LICENSE.md's END marker), then " +
    "re-run the sync.";

  test.each([
    {
      reason: "fires when the module is dropped and the old extensionless LICENSE remains",
      oldModules: ["agents", "custom-license"],
      newModules: ["agents"],
      present: ["LICENSE"],
      expected: flipMessage("LICENSE"),
    },
    {
      reason: "fires for a remaining LICENSE.md and names every leftover spelling",
      oldModules: ["custom-license"],
      newModules: [],
      present: ["LICENSE", "LICENSE.md"],
      expected: flipMessage("LICENSE and LICENSE.md"),
    },
    {
      reason: "silent when the module is kept",
      oldModules: ["custom-license"],
      newModules: ["custom-license"],
      present: ["LICENSE"],
      expected: null,
    },
    {
      reason: "silent when the module was never selected",
      oldModules: ["agents"],
      newModules: ["agents"],
      present: ["LICENSE"],
      expected: null,
    },
    {
      reason: "silent when the module is newly added",
      oldModules: ["agents"],
      newModules: ["custom-license"],
      present: ["LICENSE"],
      expected: null,
    },
    {
      reason: "silent when no license file survived the flip",
      oldModules: ["custom-license"],
      newModules: [],
      present: [],
      expected: null,
    },
  ])("$reason", ({ oldModules, newModules, present, expected }) => {
    expect(customLicenseFlipError(oldModules, newModules, present)).toBe(expected);
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
    expect(retiredPaths(listRenderPaths(oldRoot), listRenderPaths(newRoot), [], [])).toEqual([
      "copilot.md",
    ]);
  });
});

describe("readSkipIfExists", () => {
  test.each([
    {
      reason: "reads the list",
      yaml: "_skip_if_exists:\n  - .github/workflows/checks.yml\n  - release-please-config.json",
      expected: {
        patterns: [".github/workflows/checks.yml", "release-please-config.json"],
        errors: [],
      },
    },
    {
      reason: "absent list means no patterns",
      yaml: "_subdirectory: template",
      expected: { patterns: [], errors: [] },
    },
    {
      reason: "fails on a malformed list",
      yaml: "_skip_if_exists: nope",
      expected: {
        patterns: null,
        errors: ["copier.yml: _skip_if_exists must be a list of path patterns"],
      },
    },
  ])("$reason", ({ yaml, expected }) => {
    expect(readSkipIfExists(parse(yaml))).toEqual(expected);
  });
});
