// Render mode, what the run concludes: managed-region resets and their
// excerpts, the review holds, the rebuilt-paths list, and the loud exits.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fencedResetExcerpt } from "../../../.github/scripts/sync/preserve_local_content.ts";
import { tempDirs } from "../../shared/temp_dir";
import {
  AGENTS_MARKERS,
  agentsOld,
  agentsRender,
  agentsTarget,
  B,
  E,
  GITIGNORE_MARKERS,
  gitignoreManagedNew,
  gitignoreOldRender,
  gitignoreRender,
  gitignoreTarget,
  HB,
  HE,
  initGitRepo,
  MANIFEST_REL,
  MERGE_JUNK,
  runRender,
  runScript,
  type SplitSpec,
  scratchFixtures,
} from "./fixtures";

const temp = tempDirs();
const { makeTarget, makeRenderPair } = scratchFixtures(temp);

describe("fencedResetExcerpt", () => {
  test("the charged cost is the COMPLETE rendered size, fences included", () => {
    const text = "  ````text\n  plain line\n  ````";
    expect(fencedResetExcerpt(["plain line"], 1000)).toEqual({
      text,
      cost: Buffer.byteLength(text, "utf-8"),
    });
  });

  test("a backtick-heavy line's inflated fence cannot overrun the budget", () => {
    // A 290-backtick line forces two 291-backtick fences the old
    // accounting never charged: the line bytes alone fit a 320-byte
    // budget, the true rendered size does not (with or without the second
    // line), so nothing fits and the caller gets the count-only note.
    const lines = ["`".repeat(290), "ordinary dropped line"];
    expect(fencedResetExcerpt(lines, 320)).toBeNull();
    // A comfortable budget itemizes everything, still fully charged.
    const fence = "`".repeat(291);
    const roomy = `  ${fence}text\n  ${"`".repeat(290)}\n  ordinary dropped line\n  ${fence}`;
    expect(fencedResetExcerpt(lines, 4096)).toEqual({
      text: roomy,
      cost: Buffer.byteLength(roomy, "utf-8"),
    });
  });

  test("null when not even one line fits the true rendered size", () => {
    expect(fencedResetExcerpt(["x".repeat(200)], 50)).toBeNull();
  });
});

// The working tree holds copier's MERGED result (MERGE_JUNK), which the
// rebuild must discard; render_mode_rebuild.test.ts has the full convention.
describe("preserve_local_content render mode", () => {
  const securityOld = `${B}\nold security prefix\n${E}\n`;
  const securityNew = `${B}\nfresh security prefix\n${E}\n`;
  const SECURITY_MARKERS: SplitSpec = { path: "SECURITY.md", begin: B, end: E };

  test("an edit inside the managed region is reset to the fresh render and flagged", () => {
    const root = makeTarget({
      "SECURITY.md": `${B}\nold security prefix EDITED\n${E}\n`,
    });
    initGitRepo(root);
    writeFileSync(join(root, "SECURITY.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [SECURITY_MARKERS],
      { "SECURITY.md": securityNew },
      { "SECURITY.md": securityOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // Managed regions are template-owned: byte-equal to render-new.
    expect(readFileSync(join(root, "SECURITY.md"), "utf-8")).toBe(securityNew);
    expect(result.summary).toContain("RESET to the fresh render");
    // The reviewer restores from LINES, not from the fact of a reset: the
    // dropped local edit is itemized in the summary, fenced like the
    // conflict resolver's dropped hunks.
    expect(result.summary).toContain("The reset dropped these line(s):");
    expect(result.summary).toContain("old security prefix EDITED");
    expect(result.review).toContain("SECURITY.md: managed-region edits reset");
  });

  test("a locally duplicated baseline line is itemized when the duplicate drops", () => {
    // Multiset honesty: HEAD carries "shared line" twice (the repo added
    // a duplicate), the old and new renders carry it once. Comparing
    // HEAD's additions against the whole delivered region would let the
    // baseline occurrence absorb the dropped duplicate.
    const oldRegion = `${B}\nshared line\n${E}\n`;
    const newRegion = `${B}\nshared line\n${E}\n`;
    const targetDup = `${B}\nshared line\nshared line\n${E}\n`;
    const root = makeTarget({ "SECURITY.md": targetDup });
    initGitRepo(root);
    writeFileSync(join(root, "SECURITY.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [SECURITY_MARKERS],
      { "SECURITY.md": newRegion },
      { "SECURITY.md": oldRegion },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(result.review).toContain("SECURITY.md: managed-region edits reset");
    expect(result.summary).toContain("The reset dropped these line(s):");
    expect(result.summary).toContain("shared line");
  });

  test("reset excerpts share one total byte budget across files", () => {
    // Two files each dropping 40 long lines would blow past any per-file
    // bound alone; the shared budget caps the summary and the overflowing
    // file falls back to a count-only note.
    const longLines = (tag: string) =>
      Array.from({ length: 45 }, (_, i) => `${tag}-${i}-${"x".repeat(290)}`).join("\n");
    const files = ["AGENTS.md", "SECURITY.md", "CONTRIBUTING.md"];
    const targets: Record<string, string> = {};
    const news: Record<string, string> = {};
    const olds: Record<string, string> = {};
    for (const rel of files) {
      targets[rel] = `${B}\n${longLines(rel)}\n${E}\n`;
      news[rel] = `${B}\nfresh managed\n${E}\n`;
      olds[rel] = `${B}\nold managed\n${E}\n`;
    }
    const root = makeTarget(targets);
    initGitRepo(root);
    for (const rel of files) writeFileSync(join(root, rel), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      files.map((path) => ({ path, begin: B, end: E })),
      news,
      olds,
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // Bounded: well under the 64 KiB PR-body cap even with headroom for
    // the other sections.
    expect(Buffer.byteLength(result.summary, "utf-8")).toBeLessThan(24000);
    expect(result.summary).toContain("excerpt omitted: report size limit");
  });

  test("a routine template change to the managed region is not read as a local edit", () => {
    const root = makeTarget({ "SECURITY.md": `${securityOld}\n## Scope\n\nrepo tail\n` });
    initGitRepo(root);
    writeFileSync(join(root, "SECURITY.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [SECURITY_MARKERS],
      { "SECURITY.md": securityNew },
      { "SECURITY.md": securityOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "SECURITY.md"), "utf-8")).toBe(
      `${securityNew}\n## Scope\n\nrepo tail\n`,
    );
    expect(result.review).toBe("");
    expect(result.summary).not.toContain("RESET");
  });

  test("an edit inside .gitignore's managed region is reset and flagged", () => {
    const target = `# local patterns go above the managed region\n\n${HB}\n*.old\nhand-added-in-managed/\n${HE}\n`;
    const root = makeTarget({ ".gitignore": target });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_MARKERS],
      { ".gitignore": gitignoreRender },
      { ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // The preamble above the region rides through; the hand-added managed
    // line does not.
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(
      `# local patterns go above the managed region\n\n${gitignoreManagedNew}`,
    );
    expect(result.review).toContain(".gitignore: managed-region edits reset");
    // The dropped managed-region edit is itemized for the reviewer.
    expect(result.summary).toContain("hand-added-in-managed/");
  });

  test("a HEAD file with no old-render baseline is unverifiable, not clean", () => {
    // The template starts splitting a path the repo already owned: the
    // sides carry, but the managed region is replaced with no old render
    // to prove it was template content - review, not auto-merge.
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      {},
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // The sides still carry - only the managed region's provenance is in
    // question, so this is the unverifiable flag, not a reset.
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
    );
    expect(result.review).toContain("AGENTS.md: managed region unverifiable");
    expect(result.summary).not.toContain("RESET to the fresh render");
  });

  test("a repo that pre-applied the new managed region is kept whole without a reset flag", () => {
    // Nothing is dropped (the delivered region equals HEAD's), so neither
    // the reset nor the unverifiable flag may fire even though HEAD's
    // region differs from the OLD render's.
    const target = `${agentsRender}\nrepo tail\n`;
    const root = makeTarget({ "AGENTS.md": target });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(target);
    expect(result.review).toBe("");
  });

  test("--rebuilt-paths lists every split entry for the resolver's skip list", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget, ".gitignore": gitignoreTarget });
    initGitRepo(root);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS, GITIGNORE_MARKERS],
      { "AGENTS.md": agentsRender, ".gitignore": gitignoreRender },
      { "AGENTS.md": agentsOld, ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(result.rebuilt).toBe("AGENTS.md\n.gitignore\n");
  });

  test("a split entry whose file is missing from the render fails loudly", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const { renderDir, oldRenderDir } = makeRenderPair([AGENTS_MARKERS], {}, {});
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("manifest and render disagree");
  });

  test("a render without its declared region fails loudly", () => {
    // The manifest and the render are generated together: a render missing
    // its declared region means damage, and keeping it would silently drop
    // HEAD's repo-owned sides.
    const root = makeTarget({ ".gitignore": gitignoreTarget });
    initGitRepo(root);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_MARKERS],
      { ".gitignore": "no region markers here\n" },
      { ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("manifest and render disagree");
  });

  test("a render tree without the ownership manifest fails loudly", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const base = temp.dir("preserve-render-");
    mkdirSync(join(base, "render-new"));
    mkdirSync(join(base, "render-old"));
    const result = runRender(root, join(base, "render-new"), join(base, "render-old"));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("needs the new render's manifest");
  });

  test("a grammar-less RENDER manifest fails loudly instead of guessing the carry", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const base = temp.dir("preserve-render-");
    const renderDir = join(base, "render-new");
    mkdirSync(join(renderDir, ".github"), { recursive: true });
    mkdirSync(join(base, "render-old"));
    writeFileSync(
      join(renderDir, MANIFEST_REL),
      JSON.stringify({
        files: {
          "AGENTS.md": { class: "split", begin: B, end: E, hash: null },
        },
      }),
    );
    const result = runRender(root, renderDir, join(base, "render-old"));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("declares no grammar");
  });

  test("--render-dir without --old-render-dir is rejected", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const result = runScript(root, ["--render-dir", root]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--render-dir and --old-render-dir come together");
  });
});
