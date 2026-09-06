// The script in recopy mode (--root only): carrying the repo-owned sides
// back over a copier recopy that overwrote them.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "../../shared/temp_dir";
import {
  AGENTS_MARKERS,
  agentsRender,
  agentsTarget,
  B,
  contributingRender,
  contributingTarget,
  E,
  gitignoreManagedNew,
  gitignoreRender,
  gitignoreTarget,
  HB,
  HE,
  htmlAppendixCarry,
  initGitRepo,
  MANIFEST_REL,
  manifestJson,
  OLD_SENTINEL,
  otherGrammarManifestJson,
  RECOPY_ENTRIES,
  runScript,
  type SplitSpec,
  scratchFixtures,
} from "./fixtures";

const temp = tempDirs();
const { makeTarget } = scratchFixtures(temp);

const editorconfigRender = `${HB}\nroot = true\n\n[*]\ncharset = utf-8\n${HE}\n`;
const editorconfigTarget = `${HB}\nroot = true\n\n[*]\nend_of_line = lf\n${HE}\n\n[legacy/**.js]\nindent_size = 3\n`;

const codeownersRender = `${HB}\n* @vivswan\n${HE}\n`;
const codeownersTarget = `${HB}\n* @oldname\n${HE}\n\n/security/ @security-team\n`;

/** Write the post-recopy state into the working tree: the fresh renders
 * plus the fresh render's manifest (recopy always writes both). */
function writeRecopy(root: string, entries: SplitSpec[], renders: Record<string, string>): void {
  mkdirSync(join(root, dirname(MANIFEST_REL)), { recursive: true });
  writeFileSync(join(root, MANIFEST_REL), manifestJson(entries));
  for (const [rel, content] of Object.entries(renders)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

describe("preserve_local_content script (recopy mode)", () => {
  test("carries every repository-owned side over a simulated recopy", () => {
    const root = makeTarget({
      // Pre-render target state, committed as HEAD below - already in the
      // managed-region shape, with a current-vintage HEAD manifest.
      [MANIFEST_REL]: manifestJson(RECOPY_ENTRIES),
      "AGENTS.md": agentsTarget,
      ".gitignore": gitignoreTarget,
      "CONTRIBUTING.md": contributingTarget,
      "SECURITY.md": `${B}\nold security prefix\n${E}\n`,
      ".editorconfig": editorconfigTarget,
      ".github/CODEOWNERS": codeownersTarget,
      ".typography-allow.local": "docs/legacy/\n",
    });
    initGitRepo(root);
    // The recopy overwrites the managed files in the worktree and renders
    // the manifest naming every split file.
    writeRecopy(root, RECOPY_ENTRIES, {
      "AGENTS.md": agentsRender,
      ".gitignore": gitignoreRender,
      "CONTRIBUTING.md": contributingRender,
      "SECURITY.md": `${B}\nfresh security prefix\n${E}\n`,
      ".editorconfig": editorconfigRender,
      ".github/CODEOWNERS": codeownersRender,
    });

    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
    );
    // Content ABOVE the region (the .gitignore convention) rides through
    // whole: preamble, patterns, and the blank seam.
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(
      `# local patterns go above the managed region\n/repo-local-cache/\nsecret.env\n\n${gitignoreManagedNew}`,
    );
    expect(readFileSync(join(root, "CONTRIBUTING.md"), "utf-8")).toBe(
      `${contributingRender}\n## Local dev setup\n\nrun the local thing\n`,
    );
    // The hash-marker pair from the live incident: local indent rules
    // and the security-critical owners block survive under fresh renders.
    expect(readFileSync(join(root, ".editorconfig"), "utf-8")).toBe(
      `${editorconfigRender}\n[legacy/**.js]\nindent_size = 3\n`,
    );
    expect(readFileSync(join(root, ".github/CODEOWNERS"), "utf-8")).toBe(
      `${codeownersRender}\n/security/ @security-team\n`,
    );
    // Never customized outside the region: the fresh render stands.
    expect(readFileSync(join(root, "SECURITY.md"), "utf-8")).toBe(
      `${B}\nfresh security prefix\n${E}\n`,
    );
    // Separate repo-owned file, never rendered: untouched.
    expect(readFileSync(join(root, ".typography-allow.local"), "utf-8")).toBe("docs/legacy/\n");
    expect(result.summary).toContain("- `AGENTS.md`:");
    expect(result.summary).toContain("- `.gitignore`:");
    expect(result.summary).toContain("- `CONTRIBUTING.md`:");
    expect(result.summary).toContain("- `.editorconfig`:");
    expect(result.summary).toContain("- `.github/CODEOWNERS`:");
    expect(result.summary).not.toContain("SECURITY.md");
  });

  test("a recopy over an unreadable-manifest repo takes the appendix, never a conversion", () => {
    // HEAD carries a one-marker shape and manifest: the refused manifest
    // makes HEAD's declarations unusable, so the whole previous copy is
    // preserved below the appendix - a recovery sync is exactly where such
    // a repo lands. The repo-owned tail carries one
    // clean CURRENT marker pair on purpose: a carry that ignored the
    // refused manifest would split there "honestly" and hand the bytes
    // between the markers to the managed discard.
    const oldShape = `# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\ntail intro\n${B}\nREPO-OWNED SECRET\n${E}\ntail outro\n`;
    const root = makeTarget({
      [MANIFEST_REL]: otherGrammarManifestJson([{ path: "AGENTS.md", marker: OLD_SENTINEL }]),
      "AGENTS.md": oldShape,
    });
    initGitRepo(root);
    writeRecopy(root, [AGENTS_MARKERS], { "AGENTS.md": agentsRender });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      htmlAppendixCarry(agentsRender, oldShape),
    );
    expect(result.summary).toContain("recovery-appendix");
  });

  test("non-UTF-8 bytes survive the recopy carry byte-for-byte", () => {
    const tailBytes = Buffer.concat([Buffer.from("\ncaf"), Buffer.from([0xe9]), Buffer.from("\n")]);
    const root = makeTarget({});
    writeFileSync(join(root, "AGENTS.md"), Buffer.concat([Buffer.from(agentsRender), tailBytes]));
    initGitRepo(root);
    // The recopy overwrites the file with the fresh render.
    writeRecopy(root, [AGENTS_MARKERS], { "AGENTS.md": agentsRender });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    const carried = readFileSync(join(root, "AGENTS.md"));
    expect(carried.equals(Buffer.concat([Buffer.from(agentsRender), tailBytes]))).toBe(true);
  });

  test("a marker-less previous copy flows through to a marked appendix", () => {
    const legacy = "# AGENTS.md\n\nold guidance\n\n## Project docs\n\nrepo-local notes\n";
    const root = makeTarget({ "AGENTS.md": legacy });
    initGitRepo(root);
    writeRecopy(root, [AGENTS_MARKERS], { "AGENTS.md": agentsRender });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(agents).toStartWith(agentsRender);
    expect(agents).toContain("repo-platform:recovery-appendix");
    expect(agents).toEndWith(legacy);
    expect(result.summary).toContain("recovery-appendix");
  });

  test("a split file new in the render (absent from HEAD) is left as rendered", () => {
    const root = makeTarget({ "README.md": "readme\n" });
    initGitRepo(root);
    writeRecopy(root, [AGENTS_MARKERS], { "AGENTS.md": agentsRender });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(agentsRender);
    expect(result.summary).toBe("");
  });

  test("a symlink at HEAD at a split path keeps the recopied render and says so", () => {
    // `git show` answers a symlink's target path string, not file
    // content: nothing exists to carry, so the recopied render stands and
    // the summary names the non-blob shape (recovery PRs are manual
    // wholesale, so the note is the whole signal).
    const root = makeTarget({ "REAL.md": agentsTarget });
    symlinkSync("REAL.md", join(root, "AGENTS.md"));
    initGitRepo(root);
    unlinkSync(join(root, "AGENTS.md"));
    writeRecopy(root, [AGENTS_MARKERS], { "AGENTS.md": agentsRender });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    const delivered = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(delivered).toBe(agentsRender);
    expect(delivered).not.toContain("recovery-appendix");
    expect(result.summary).toContain("carries a symlink at this path, not a regular file");
  });

  test("a marker-bearing file not declared split in the manifest is untouched", () => {
    // The manifest, not a marker scan, drives the file list.
    const root = makeTarget({ "NOTES.md": `${B}\nnote\n${E}\nlocal tail\n` });
    initGitRepo(root);
    writeRecopy(root, [], { "NOTES.md": `${B}\nfresh note\n${E}\n` });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "NOTES.md"), "utf-8")).toBe(`${B}\nfresh note\n${E}\n`);
    expect(result.summary).toBe("");
  });

  test("a working tree without the recopied manifest fails loudly", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    // HEAD keeps its manifest; the recopy is what failed to write one.
    rmSync(join(root, MANIFEST_REL));
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("needs the recopied render's manifest");
  });

  test("a split entry whose file is missing from the recopied tree fails loudly", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    writeRecopy(root, [{ path: "GHOST.md", begin: B, end: E }], {});
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("manifest and render disagree");
  });

  test("--hide-details prints a count, not paths", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    writeRecopy(root, [AGENTS_MARKERS], { "AGENTS.md": agentsRender });
    const result = runScript(root, ["--hide-details", "true"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 split file(s) carry a disposition note");
    expect(result.stdout).not.toContain("AGENTS.md");
    expect(result.summary).toContain("- `AGENTS.md`:");
  });

  test("fails closed when HEAD is unreadable (not a git repository)", () => {
    const root = makeTarget({ "AGENTS.md": agentsRender });
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cannot resolve HEAD");
  });

  test("writes an empty summary when nothing needed carrying", () => {
    const root = makeTarget({ "AGENTS.md": agentsRender });
    initGitRepo(root);
    writeRecopy(root, [AGENTS_MARKERS], { "AGENTS.md": agentsRender });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("");
    expect(result.stdout).toContain("no repo-local content needed carrying over");
  });
});
