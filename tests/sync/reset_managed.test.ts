// reset_managed.ts on a fixture pair: the render's manifest names one file
// per ownership class plus two symlinks and a path the tree lacks; the tree
// carries a local edit in every one of them and a file the render retired.
// One assertion pins the whole tree after the reset, so a class the reset
// wrongly touches (a split file, a starter) or wrongly skips (the manifest,
// a re-linked symlink) fails here.

import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { replacedReport, resetManaged } from "../../.github/scripts/sync/reset_managed.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const MANIFEST = ".github/repo-platform-manifest.json";

function manifest(files: Record<string, Record<string, unknown>>): string {
  return `${JSON.stringify({ files }, null, 2)}\n`;
}

/** Every path under `root` (sorted) with its content, or `-> target` for a symlink. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(root, childRel));
      if (stat.isSymbolicLink()) out[childRel] = `-> ${readlinkSync(join(root, childRel))}`;
      else if (stat.isDirectory()) visit(childRel);
      else out[childRel] = readFileSync(join(root, childRel), "utf-8");
    }
  };
  visit("");
  return out;
}

function write(root: string, files: Record<string, string>, links: Record<string, string> = {}) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  for (const [rel, target] of Object.entries(links)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    symlinkSync(target, join(root, rel));
  }
}

const SPLIT = { class: "split", grammar: "managed-region", begin: "# BEGIN", end: "# END" };
const HASH = "0".repeat(64);
/** The render's manifest, or the same declarations under other stamp-derived values. */
function renderManifest(stamp: { hash: string | null; commit: string | null }): string {
  return manifest({
    [MANIFEST]: { class: "managed", hash: stamp.hash, commit: stamp.commit },
    ".github/workflows/ci.yml": { class: "managed", hash: stamp.hash },
    ".bun-version": { class: "managed", hash: stamp.hash },
    "CLAUDE.md": { class: "managed", hash: stamp.hash },
    ".github/agents.md": { class: "managed", hash: stamp.hash },
    "new/module/added.yml": { class: "managed", hash: stamp.hash },
    "AGENTS.md": { ...SPLIT, hash: stamp.hash },
    ".github/settings.yml": { class: "starter" },
  });
}
const RENDER_MANIFEST = renderManifest({ hash: HASH, commit: "a".repeat(40) });

describe("reset_managed", () => {
  test("managed files land whole from the render; split, starter, and retired files keep the tree's bytes", () => {
    const render = temp.dir("reset-render-");
    const tree = temp.dir("reset-tree-");
    write(
      render,
      {
        [MANIFEST]: RENDER_MANIFEST,
        ".github/workflows/ci.yml": "name: ci\nmodules: [uv, fuzzer]\n",
        ".bun-version": "1.4.0\n",
        "new/module/added.yml": "name: added\n",
        "AGENTS.md": "# BEGIN\nrender region\n# END\n",
        ".github/settings.yml": "starter: render\n",
      },
      { "CLAUDE.md": "AGENTS.md", ".github/agents.md": "../AGENTS.md" },
    );
    write(
      tree,
      {
        // copier's post-render stamp recorded the tree's own hashes: a
        // derived difference, replaced but not a local edit.
        [MANIFEST]: renderManifest({ hash: "f".repeat(64), commit: "b".repeat(40) }),
        // copier's three-way merge kept the trailing local comment.
        ".github/workflows/ci.yml": "name: ci\nmodules: [uv, fuzzer]\n# local ci note\n",
        ".bun-version": "1.4.0\n",
        // A regular file where the render has a symlink.
        "CLAUDE.md": "not a link\n",
        "AGENTS.md": "repo above\n# BEGIN\nrender region\n# END\nrepo below\n",
        ".github/settings.yml": "starter: local edit\n",
        "retired.yml": "retired managed file\n",
      },
      // A symlink with the wrong target.
      { ".github/agents.md": "../OTHER.md" },
    );

    const report = resetManaged(render, tree);

    const edited = [
      ".github/agents.md",
      ".github/workflows/ci.yml",
      "CLAUDE.md",
      "new/module/added.yml",
    ].sort();
    expect({ report, tree: snapshot(tree) }).toEqual({
      report: { replaced: [...edited, MANIFEST].sort(), edited, matched: 1 },
      tree: {
        [MANIFEST]: RENDER_MANIFEST,
        ".github/agents.md": "-> ../AGENTS.md",
        ".github/settings.yml": "starter: local edit\n",
        ".github/workflows/ci.yml": "name: ci\nmodules: [uv, fuzzer]\n",
        ".bun-version": "1.4.0\n",
        "AGENTS.md": "repo above\n# BEGIN\nrender region\n# END\nrepo below\n",
        "CLAUDE.md": "-> AGENTS.md",
        "new/module/added.yml": "name: added\n",
        "retired.yml": "retired managed file\n",
      },
    });
  });

  // The manifest is a local edit only when its DECLARATIONS changed: a
  // hand-flipped class is one (docs/compose.md), stale hashes are not (the
  // main case above), and a manifest that no longer parses is one too.
  test.each<{ reason: string; treeManifest: string; edited: string[] }>([
    {
      reason: "a class flipped by hand",
      treeManifest: RENDER_MANIFEST.replace(
        '".github/workflows/ci.yml": {\n      "class": "managed"',
        '".github/workflows/ci.yml": {\n      "class": "starter"',
      ),
      edited: [MANIFEST],
    },
    {
      reason: "an entry removed by hand",
      treeManifest: manifest({ [MANIFEST]: { class: "managed", hash: HASH } }),
      edited: [MANIFEST],
    },
    { reason: "a manifest that does not parse", treeManifest: "{ not json\n", edited: [MANIFEST] },
    {
      reason: "stale hashes and provenance alone",
      treeManifest: renderManifest({ hash: null, commit: null }),
      edited: [],
    },
  ])("the manifest counts as a local edit for $reason", ({ treeManifest, edited }) => {
    const render = temp.dir("reset-render-");
    const tree = temp.dir("reset-tree-");
    const files = {
      ".github/workflows/ci.yml": "x\n",
      ".bun-version": "1\n",
      "new/module/added.yml": "a\n",
      "AGENTS.md": "# BEGIN\n# END\n",
      ".github/settings.yml": "s\n",
    };
    const links = { "CLAUDE.md": "AGENTS.md", ".github/agents.md": "../AGENTS.md" };
    write(render, { [MANIFEST]: RENDER_MANIFEST, ...files }, links);
    write(tree, { [MANIFEST]: treeManifest, ...files }, links);
    expect(resetManaged(render, tree)).toEqual({ replaced: [MANIFEST], edited, matched: 5 });
    expect(readFileSync(join(tree, MANIFEST), "utf-8")).toBe(RENDER_MANIFEST);
  });

  test.each<{ reason: string; edited: string[]; report: string }>([
    { reason: "no local edits: no report", edited: [], report: "" },
    {
      reason: "every edited path is listed under the warning",
      edited: [".github/workflows/ci.yml", "CLAUDE.md"],
      report: [
        "> [!WARNING]",
        "> These managed files carried local edits that copier's merge kept; this",
        "> update replaces each file whole with the clean render (docs/compose.md,",
        "> ownership classes). The PR diff shows the removed lines; content that",
        "> must survive belongs in a repository-owned file.",
        "",
        "- `.github/workflows/ci.yml`",
        "- `CLAUDE.md`",
        "",
      ].join("\n"),
    },
  ])("replacedReport: $reason", ({ edited, report }) => {
    expect(replacedReport(edited)).toBe(report);
  });

  test("a second run is a no-op: every managed entry already matches", () => {
    const render = temp.dir("reset-render-");
    const tree = temp.dir("reset-tree-");
    write(
      render,
      {
        [MANIFEST]: RENDER_MANIFEST,
        ".github/workflows/ci.yml": "x\n",
        ".bun-version": "1\n",
        "new/module/added.yml": "a\n",
        "AGENTS.md": "# BEGIN\n# END\n",
        ".github/settings.yml": "s\n",
      },
      { "CLAUDE.md": "AGENTS.md", ".github/agents.md": "../AGENTS.md" },
    );
    write(tree, { [MANIFEST]: "{}\n" });
    resetManaged(render, tree);
    expect(resetManaged(render, tree)).toEqual({ replaced: [], edited: [], matched: 6 });
  });

  test.each<{ reason: string; files: Record<string, string>; message: string }>([
    {
      reason: "a managed entry the render does not carry",
      files: { [MANIFEST]: manifest({ "ghost.yml": { class: "managed", hash: null } }) },
      message: "declares a managed entry for ghost.yml, but the render has no such file",
    },
    {
      reason: "a managed entry whose path could escape the target root",
      files: { [MANIFEST]: manifest({ "../escape.yml": { class: "managed", hash: null } }) },
      message: "declares a managed entry at an unsafe path",
    },
    {
      reason: "a manifest that does not parse",
      files: { [MANIFEST]: "{ not json\n" },
      message: "does not parse as a manifest",
    },
  ])("refuses $reason without writing", ({ files, message }) => {
    const render = temp.dir("reset-render-");
    const tree = temp.dir("reset-tree-");
    write(render, files);
    write(tree, { "kept.txt": "kept\n" });
    expect(() => resetManaged(render, tree)).toThrow(message);
    expect(snapshot(tree)).toEqual({ "kept.txt": "kept\n" });
  });
});
