// The module-render verdict's pure pieces: compareManaged over planted
// render/tree pairs (each row one whole outcome), readSelection over the
// registration and answers shapes it accepts and refuses, and the remedy
// line the failing step prints.

import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareManaged, remedyLine, shellWord } from "../../../actions/module-render/src/compare";
import { readSelection } from "../../../actions/module-render/src/selection";
import { MANIFEST_NAME } from "../../../actions/shared/manifest";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SHA = "6bf545284a2f8e32d82fdc663d4b3333f8fb37bf";
const BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const END = "# END REPO-PLATFORM MANAGED";

type Entry = { class: string; begin?: string; end?: string };
interface Tree {
  /** Manifest entries; hashes are irrelevant (the comparison re-hashes). */
  manifest?: Record<string, Entry>;
  files?: Record<string, string>;
  links?: Record<string, string>;
}

function plant(root: string, tree: Tree): void {
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  if (tree.manifest !== undefined) {
    write(MANIFEST_NAME, JSON.stringify({ files: tree.manifest }));
  }
  for (const [rel, text] of Object.entries(tree.files ?? {})) write(rel, text);
  for (const [rel, target] of Object.entries(tree.links ?? {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    symlinkSync(target, join(root, rel));
  }
}

const managed: Entry = { class: "managed" };
const starter: Entry = { class: "starter" };
const split: Entry = { class: "split", begin: BEGIN, end: END };
const region = (body: string) => `${BEGIN}\n${body}\n${END}\n`;

describe("compareManaged", () => {
  test.each<{
    reason: string;
    render: Tree;
    tree: Tree;
    expected: ReturnType<typeof compareManaged>;
  }>([
    {
      reason:
        "identical managed files, a split file whose repo-owned tail differs, a starter that differs, the same symlink target: fresh",
      render: {
        manifest: {
          "ci.yml": managed,
          ".gitignore": split,
          "checks.yml": starter,
          "CLAUDE.md": managed,
        },
        files: {
          "ci.yml": "jobs: a\n",
          ".gitignore": region("node_modules"),
          "checks.yml": "template\n",
        },
        links: { "CLAUDE.md": "AGENTS.md" },
      },
      tree: {
        manifest: {
          "ci.yml": managed,
          ".gitignore": split,
          "checks.yml": starter,
          "CLAUDE.md": managed,
        },
        files: {
          "ci.yml": "jobs: a\n",
          ".gitignore": `local/\n${region("node_modules")}more/\n`,
          "checks.yml": "edited\n",
        },
        links: { "CLAUDE.md": "AGENTS.md" },
      },
      expected: { kind: "compared", stale: [], retired: [], compared: 3 },
    },
    {
      reason:
        "a managed file with other bytes, one missing from the tree, a split region that differs, a symlink with another target: each stale",
      render: {
        manifest: {
          "ci.yml": managed,
          "new.yml": managed,
          ".gitignore": split,
          "CLAUDE.md": managed,
        },
        files: { "ci.yml": "jobs: a\n", "new.yml": "x\n", ".gitignore": region("dist") },
        links: { "CLAUDE.md": "AGENTS.md" },
      },
      tree: {
        manifest: { "ci.yml": managed, ".gitignore": split, "CLAUDE.md": managed },
        files: { "ci.yml": "jobs: b\n", ".gitignore": region("node_modules") },
        links: { "CLAUDE.md": "README.md" },
      },
      expected: {
        kind: "compared",
        stale: [".gitignore", "CLAUDE.md", "ci.yml", "new.yml"],
        retired: [],
        compared: 4,
      },
    },
    {
      reason: "a split file whose tree copy lost its markers cannot be compared and is stale",
      render: { manifest: { ".gitignore": split }, files: { ".gitignore": region("dist") } },
      tree: { manifest: { ".gitignore": split }, files: { ".gitignore": "dist\n" } },
      expected: { kind: "compared", stale: [".gitignore"], retired: [], compared: 1 },
    },
    {
      reason:
        "sync-written paths the render no longer carries are retired; a starter or the manifest itself never is",
      render: { manifest: { "ci.yml": managed }, files: { "ci.yml": "jobs: a\n" } },
      tree: {
        manifest: {
          "ci.yml": managed,
          "pages.yml": managed,
          "CONTRIBUTING.md": split,
          "nightly.yml": starter,
        },
        files: {
          "ci.yml": "jobs: a\n",
          "pages.yml": "x\n",
          "CONTRIBUTING.md": region("c"),
          "nightly.yml": "n\n",
        },
      },
      expected: {
        kind: "compared",
        stale: [],
        retired: ["CONTRIBUTING.md", "pages.yml"],
        compared: 1,
      },
    },
    {
      reason: "the render's manifest missing is unreadable",
      render: { files: { "ci.yml": "x\n" } },
      tree: { manifest: { "ci.yml": managed }, files: { "ci.yml": "x\n" } },
      expected: { kind: "unreadable", problem: `the render carries no ${MANIFEST_NAME}` },
    },
    {
      reason: "a malformed repository manifest is unreadable, with the shared parser's problem",
      render: { manifest: { "ci.yml": managed }, files: { "ci.yml": "x\n" } },
      tree: { files: { [MANIFEST_NAME]: "{not json", "ci.yml": "x\n" } },
      expected: {
        kind: "unreadable",
        problem: `the repository's ${MANIFEST_NAME} does not parse as a manifest (invalid JSON)`,
      },
    },
  ])("$reason", ({ render, tree, expected }) => {
    const root = temp.dir("module-render-compare-");
    const renderRoot = join(root, "render");
    const treeRoot = join(root, "tree");
    mkdirSync(renderRoot);
    mkdirSync(treeRoot);
    plant(renderRoot, render);
    plant(treeRoot, tree);
    expect(compareManaged(renderRoot, treeRoot)).toEqual(expected);
  });
});

describe("readSelection", () => {
  const answers = (extra = "") =>
    `_commit: ${SHA}\n_src_path: gh:Vivswan/repo-platform\ndescription: A repo\nprivate: false\n${extra}`;
  test.each<{
    reason: string;
    files: Record<string, string>;
    expected: ReturnType<typeof readSelection>;
  }>([
    {
      reason: "a full render: the sha, the list, the two live answers",
      files: {
        ".repo-platform.yml": 'modules: ["uv", "fuzzer"]\n',
        ".github/.copier-answers.yml": answers(),
      },
      expected: {
        selection: {
          commit: SHA,
          modules: ["uv", "fuzzer"],
          private: false,
          description: "A repo",
        },
      },
    },
    {
      reason:
        "a private repository with a non-string description renders private with an empty description",
      files: {
        ".repo-platform.yml": "modules:\n  - bun\n",
        ".github/.copier-answers.yml": `_commit: ${SHA}\nprivate: true\ndescription: 123\n`,
      },
      expected: { selection: { commit: SHA, modules: ["bun"], private: true, description: "" } },
    },
    {
      reason: "a short sha is the recorded-build refusal",
      files: {
        ".repo-platform.yml": "modules: [uv]\n",
        ".github/.copier-answers.yml": "_commit: abc1234\n",
      },
      expected: {
        refusal:
          "_commit 'abc1234' is not a full build sha; merge this repository's pending template sync PR",
      },
    },
    {
      reason: "no registration file",
      files: { ".github/.copier-answers.yml": answers() },
      expected: { refusal: ".repo-platform.yml is missing or is not a YAML mapping" },
    },
    {
      reason: "modules that are not a list of names",
      files: { ".repo-platform.yml": "modules: uv\n", ".github/.copier-answers.yml": answers() },
      expected: { refusal: ".repo-platform.yml: top-level modules must be a list of module names" },
    },
    {
      reason: "an answers file that records a sha but does not parse as a mapping",
      files: {
        ".repo-platform.yml": "modules: [uv]\n",
        ".github/.copier-answers.yml": `_commit: ${SHA}\n- not: a mapping\n`,
      },
      expected: { refusal: ".github/.copier-answers.yml is missing or is not a YAML mapping" },
    },
  ])("$reason", ({ files, expected }) => {
    const root = temp.dir("module-render-selection-");
    plant(root, { files });
    expect(readSelection(root)).toEqual(expected);
  });
});

describe("remedyLine", () => {
  test.each<{ headRef: string; branchWord: string }>([
    { headRef: "chore/fuzzer-module", branchWord: "chore/fuzzer-module" },
    { headRef: "", branchWord: "<the pull request's head branch>" },
    // A valid branch name the shell would misparse bare is quoted.
    { headRef: "feat/fuzzer(uv)", branchWord: "'feat/fuzzer(uv)'" },
    { headRef: "it's", branchWord: String.raw`'it'\''s'` },
  ])(
    "names the operator's sync, the repository, and the branch as one shell word ($headRef)",
    ({ headRef, branchWord }) => {
      expect(remedyLine("Vivswan/cloud-speech", headRef)).toBe(
        `gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/cloud-speech -f branch=${branchWord}`,
      );
    },
  );

  test("shellWord leaves path-safe names bare and quotes the rest", () => {
    expect(["main", "a b", "x;y"].map(shellWord)).toEqual(["main", "'a b'", "'x;y'"]);
  });
});
