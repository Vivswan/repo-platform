// Render mode, the rebuild itself: the sides carried from HEAD, the
// appendix fallbacks, and the non-regular-file shapes at a split path.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
  HB,
  HE,
  htmlAppendixCarry,
  initGitRepo,
  MANIFEST_REL,
  MERGE_JUNK,
  manifestJson,
  OLD_GUIDANCE,
  OLD_LOCAL_BEGIN,
  OLD_SENTINEL,
  otherGrammarManifestJson,
  runRender,
  scratchFixtures,
} from "./fixtures";

const temp = tempDirs();
const { makeTarget, makeRenderPair } = scratchFixtures(temp);

// Render mode: the primary sync path. The working tree holds copier's
// MERGED result, which the rebuild must DISCARD - every fixture below
// plants junk there to prove the output comes from (render-new, HEAD)
// only. HEAD is the committed pre-update state; render-old/render-new are
// clean renders at the old and new template refs.
describe("preserve_local_content render mode", () => {
  test("rebuilds a split file from the clean render and HEAD, discarding the merge", () => {
    const root = makeTarget({
      [MANIFEST_REL]: manifestJson([AGENTS_MARKERS]),
      "AGENTS.md": agentsTarget,
    });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // Managed region byte-equal to render-new, tail byte-equal to HEAD's.
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
    );
    expect(result.summary).toContain("- `AGENTS.md`:");
    expect(result.summary).toContain("rebuilt structurally");
    // A template change to the managed region is routine, not a local
    // edit: nothing to review, the PR stays auto-merge-eligible.
    expect(result.review).toBe("");
  });

  test("a HEAD with no manifest at all is unusable: the appendix and a review hold, never a guessed split", () => {
    // The previous copy carries one clean CURRENT marker pair on purpose:
    // a carry that fell back to the new markers would split there
    // "honestly" and hand the bytes between them to the managed discard.
    const previous = `intro\n${B}\nREPO-OWNED SECRET\n${E}\noutro\n`;
    const root = makeTarget({ "AGENTS.md": previous }, { headManifest: false });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      htmlAppendixCarry(agentsRender, previous),
    );
    expect(result.review).toContain("AGENTS.md: recovery-appendix");
  });

  test("a one-marker repo gets the appendix and a review hold, never a conversion", () => {
    // HEAD state: a one-marker file plus a manifest declaring that
    // grammar. The refused manifest yields no HEAD
    // declarations, the old shape has no BEGIN/END region, and the whole
    // previous copy (non-UTF-8 byte included) is preserved below the
    // appendix with the PR held for review - loud beats a guessed split.
    const tailBytes = Buffer.concat([
      Buffer.from("\n## Project docs\n\ncaf"),
      Buffer.from([0xe9]),
      Buffer.from(" repo-local instructions\n"),
    ]);
    const oldShapeHead = Buffer.concat([
      Buffer.from(`# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\n`),
      tailBytes,
    ]);
    const root = makeTarget({
      [MANIFEST_REL]: otherGrammarManifestJson([{ path: "AGENTS.md", marker: OLD_SENTINEL }]),
    });
    writeFileSync(join(root, "AGENTS.md"), oldShapeHead);
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const delivered = readFileSync(join(root, "AGENTS.md"));
    const asText = delivered.toString("latin1");
    expect(asText).toStartWith(agentsRender);
    expect(asText).toContain("repo-platform:recovery-appendix");
    // Byte-fidelity: the appendix carries the previous copy verbatim.
    expect(delivered.subarray(delivered.length - oldShapeHead.length).equals(oldShapeHead)).toBe(
      true,
    );
    expect(result.review).toContain("AGENTS.md: recovery-appendix");
  });

  test("a four-marker .gitignore takes the appendix too, its extra lines preserved", () => {
    // The four-marker shape carries the current BEGIN/END pair inside its
    // managed half, so it WOULD split at the new markers - but HEAD's
    // refused manifest makes every declaration untrustworthy, and a
    // guessed split is exactly the misattribution hazard. The whole copy
    // rides the appendix, the extra marker lines included (repo bytes).
    const above = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n/repo-local-cache/\nsecret.env\n\n`;
    const oldHead = `${above}${HB}\n*.old\n${HE}\n`;
    const root = makeTarget({
      [MANIFEST_REL]: otherGrammarManifestJson([{ path: ".gitignore", marker: HB }]),
      ".gitignore": oldHead,
    });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_MARKERS],
      { ".gitignore": gitignoreRender },
      { ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const delivered = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(delivered).toStartWith(gitignoreRender);
    expect(delivered).toContain("repo-platform:recovery-appendix");
    expect(delivered).toContain(OLD_LOCAL_BEGIN);
    expect(delivered).toContain(OLD_GUIDANCE);
    expect(delivered).toContain("/repo-local-cache/");
    expect(result.review).toContain(".gitignore: recovery-appendix");
  });

  test("a STEADY-STATE sync of a marker-spelling .gitignore strips nothing, ever", () => {
    // A repo-owned side that happens to hold a marker-shaped spelling
    // keeps it byte-identical on every sync.
    const above = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n/repo-local-cache/\n\n`;
    const oldHead = `${above}${HB}\n*.old\n${HE}\n`;
    const root = makeTarget({
      [MANIFEST_REL]: manifestJson([GITIGNORE_MARKERS]),
      ".gitignore": oldHead,
    });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_MARKERS],
      { ".gitignore": gitignoreRender },
      { ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(`${above}${gitignoreManagedNew}`);
  });

  test("IDEMPOTENT: a second sync over a carried .gitignore rewrites nothing", () => {
    // The carried state is a fixed point: HEAD already holds the delivered
    // shape, so the steady-state path runs and the file keeps its bytes.
    const converted = `/repo-local-cache/\n\n${gitignoreManagedNew}`;
    const root = makeTarget({
      [MANIFEST_REL]: manifestJson([GITIGNORE_MARKERS]),
      ".gitignore": converted,
    });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_MARKERS],
      { ".gitignore": gitignoreRender },
      { ".gitignore": gitignoreRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(converted);
    expect(result.review).toBe("");
  });

  test("content ABOVE the region round-trips through a real render-mode run", () => {
    const target = `repo-owned preamble\n\n${agentsOld}repo tail\n`;
    const root = makeTarget({
      [MANIFEST_REL]: manifestJson([AGENTS_MARKERS]),
      "AGENTS.md": target,
    });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `repo-owned preamble\n\n${agentsRender}repo tail\n`,
    );
    expect(result.review).toBe("");
  });

  test("a symlinked ancestor directory refuses the rebuild write loudly", () => {
    // writeFileSync would follow `docs -> outside` and land the write
    // outside the checkout with the final component looking clean.
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const outside = temp.dir("preserve-outside-");
    symlinkSync(outside, join(root, "docs"));
    const { renderDir, oldRenderDir } = makeRenderPair(
      [{ path: "docs/AGENTS.md", begin: B, end: E }],
      { "docs/AGENTS.md": agentsRender },
      {},
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ancestor 'docs' is a symbolic link");
    expect(existsSync(join(outside, "AGENTS.md"))).toBe(false);
  });

  test("a symlink at HEAD at a split path keeps the clean render and routes to review", () => {
    // `git show HEAD:AGENTS.md` answers the TARGET PATH STRING for a
    // symlink; feeding that to the carry as if it were the previous copy
    // would "preserve" the link target in a recovery appendix. No file
    // content exists at HEAD here: the render stands, and the note routes
    // the PR to manual review.
    const root = makeTarget({ "REAL.md": agentsTarget });
    symlinkSync("REAL.md", join(root, "AGENTS.md"));
    initGitRepo(root);
    unlinkSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const delivered = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(delivered).toBe(agentsRender);
    expect(delivered).not.toContain("recovery-appendix");
    expect(lstatSync(join(root, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(result.summary).toContain("carries a symlink at this path, not a regular file");
    expect(result.review).toContain("AGENTS.md: previous copy not a regular file");
  });

  test("a directory at HEAD at a split path keeps the clean render and routes to review", () => {
    // `git show HEAD:AGENTS.md` answers "tree HEAD:AGENTS.md" plus entry
    // names for a directory; that prose must never ride into the
    // delivered file as a "previous copy".
    const root = makeTarget({ "AGENTS.md/inner.md": agentsTarget });
    initGitRepo(root);
    rmSync(join(root, "AGENTS.md"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const delivered = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(delivered).toBe(agentsRender);
    expect(delivered).not.toContain("tree HEAD:");
    expect(result.summary).toContain("carries a directory at this path, not a regular file");
    expect(result.review).toContain("AGENTS.md: previous copy not a regular file");
  });

  test("a marker-bearing file not declared split in the manifest is untouched", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget, "NOTES.md": `${B}\nnote\n${E}\n` });
    initGitRepo(root);
    writeFileSync(join(root, "NOTES.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // The manifest, not a marker scan, drives the file list.
    expect(readFileSync(join(root, "NOTES.md"), "utf-8")).toBe(MERGE_JUNK);
  });

  test("a split file absent from HEAD is written as the clean render", () => {
    const root = makeTarget({ "README.md": "readme\n" });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      {},
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(agentsRender);
    expect(result.summary).toBe("");
    expect(result.review).toBe("");
  });

  test("an unsplittable previous copy takes the appendix and flags review", () => {
    const legacy = "# AGENTS.md\n\nold guidance, no marker\n\nrepo-local notes\n";
    const root = makeTarget({ "AGENTS.md": legacy });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const rebuilt = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(rebuilt).toStartWith(agentsRender);
    expect(rebuilt).toContain("repo-platform:recovery-appendix");
    expect(rebuilt).toEndWith(legacy);
    expect(result.review).toContain("AGENTS.md: recovery-appendix");
  });

  test("non-UTF-8 bytes in the repo-owned sides survive byte-for-byte", () => {
    // A Latin-1 0xe9 ("caf<e9>") is not valid UTF-8; a utf-8 decode would
    // fold it onto U+FFFD and grow the file - silent corruption of the
    // byte-owned sides.
    const tailBytes = Buffer.concat([
      Buffer.from("\n## Notes\n\ncaf"),
      Buffer.from([0xe9]),
      Buffer.from("\n"),
    ]);
    const root = makeTarget({});
    writeFileSync(join(root, "AGENTS.md"), Buffer.concat([Buffer.from(agentsOld), tailBytes]));
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const rebuilt = readFileSync(join(root, "AGENTS.md"));
    expect(rebuilt.equals(Buffer.concat([Buffer.from(agentsRender), tailBytes]))).toBe(true);
    expect(result.review).toBe("");
  });

  test("a carried tail keeps conflict-marker-shaped text byte-for-byte", () => {
    // The resolver skips rebuilt files (--skip); the rebuild itself must
    // also carry such a tail untouched.
    const markerish = [`${"<".repeat(7)} before updating`, "=".repeat(7)].join("\n");
    const target = `${agentsOld}\n## Notes on merges\n\n${markerish}\n`;
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
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Notes on merges\n\n${markerish}\n`,
    );
  });

  test("a split path replaced by a symlink is rebuilt as a regular file, never through the link", () => {
    // writeFileSync follows an existing symlink: without the guard, the
    // rebuild would overwrite the link TARGET (potentially outside the
    // checkout) and leave the symlink in place.
    const root = makeTarget({ "AGENTS.md": agentsTarget, "victim.txt": "victim content\n" });
    initGitRepo(root);
    unlinkSync(join(root, "AGENTS.md"));
    symlinkSync("victim.txt", join(root, "AGENTS.md"));
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(lstatSync(join(root, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
    );
    expect(readFileSync(join(root, "victim.txt"), "utf-8")).toBe("victim content\n");
  });

  test("an unreadable HEAD manifest degrades to the appendix, never a guessed split", () => {
    // The HEAD manifest is damaged, so no declaration is trusted from it
    // and the whole previous copy is preserved below the appendix, review
    // forced. The repo-owned tail carries one clean CURRENT marker pair on
    // purpose: a rebuild that ignored the damaged manifest would split
    // there and hand the bytes between the markers to the managed discard.
    const oldShape = `old managed\n${OLD_SENTINEL}\ntail intro\n${B}\nREPO-OWNED SECRET\n${E}\ntail outro\n`;
    const root = makeTarget({
      [MANIFEST_REL]: "not json at all",
      "AGENTS.md": oldShape,
    });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": `old managed\n${OLD_SENTINEL}\n` },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      htmlAppendixCarry(agentsRender, oldShape),
    );
    expect(result.review).toContain("AGENTS.md: recovery-appendix");
  });
});
