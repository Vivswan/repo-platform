// Fixtures shared by the preserve_local_content suites: the marker
// vocabulary, manifest and render builders, the script runner, and the
// scratch-checkout builders (bound to each file's own TempDirs).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import type { TempDirs } from "../../shared/temp_dir";

export const script = join(
  import.meta.dir,
  "../../../.github/scripts/sync/preserve_local_content.ts",
);
export const repoRoot = join(import.meta.dir, "..", "..", "..");

// The one marker vocabulary (actions/shared/grammar.ts).
export const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
export const E = "<!-- END REPO-PLATFORM MANAGED -->";
export const HB = "# BEGIN REPO-PLATFORM MANAGED";
export const HE = "# END REPO-PLATFORM MANAGED";

// Marker-shaped spellings the sync does not own: the fixtures below use
// them to prove that a repo whose HEAD carries some other shape (or a
// manifest the sync cannot read) gets the loud fail-closed path, never a
// conversion.
export const OLD_SENTINEL = "<!-- other-tool:section -->";
export const OLD_LOCAL_BEGIN = "# BEGIN OTHER LOCAL";
// A guidance-shaped comment line in repo-owned space: kept byte-identical
// like any other repo-owned line.
export const OLD_GUIDANCE = "# Add repository-specific ignore patterns in this section only.";

export const MANIFEST_REL = ".github/repo-platform-manifest.json";

// The recovery appendix comment withRegionAppendix writes for HTML-comment
// markers: appendix carries are pinned as whole files against it, so a
// drifted spelling or a lost marker neutralization is a byte diff here.
const HTML_APPENDIX = [
  "<!-- repo-platform:recovery-appendix",
  "The template sync's re-render could not tell this file's",
  "repository-owned content apart from its managed region, so the",
  "previous copy is preserved in full below (any managed-region marker",
  "text in it is dash-joined to stay inert). Keep what is",
  "repository-owned, drop what the managed region above already covers,",
  "then delete this comment. -->",
].join("\n");

/** The appendix carry's whole delivered file: `render`, the appendix, then
 * `previous` in full with every occurrence of the HTML markers neutralized
 * to the inert dash-joined forms (the render's pair must stay the file's
 * only marker occurrences). */
export function htmlAppendixCarry(render: string, previous: string): string {
  const neutralized = previous
    .replaceAll(B, "<!---BEGIN-REPO-PLATFORM-MANAGED--->")
    .replaceAll(E, "<!---END-REPO-PLATFORM-MANAGED--->");
  return `${render}\n${HTML_APPENDIX}\n\n${neutralized}`;
}

export interface SplitSpec {
  path: string;
  begin: string;
  end: string;
}

/** A manifest carrying the given split entries, in the shape
 * compose/manifest.ts emits (one grammar: managed-region, begin/end). */
export function manifestJson(entries: SplitSpec[]): string {
  return JSON.stringify({
    files: Object.fromEntries(
      entries.map((e) => [
        e.path,
        { class: "split", grammar: "managed-region", begin: e.begin, end: e.end, hash: null },
      ]),
    ),
  });
}

/** A manifest declaring a grammar the sync does not read (one-marker).
 * headSplitEntries refuses it, and the carry falls back to the new
 * entries' markers with the appendix behind them. */
export function otherGrammarManifestJson(entries: { path: string; marker: string }[]): string {
  return JSON.stringify({
    files: Object.fromEntries(
      entries.map((e) => [
        e.path,
        { class: "split", grammar: "one-marker", marker: e.marker, managed: "above", hash: null },
      ]),
    ),
  });
}

export const AGENTS_MARKERS: SplitSpec = { path: "AGENTS.md", begin: B, end: E };
export const agentsRender = `${B}\n# AGENTS.md\n\nfresh managed guidance\n${E}\n`;
export const agentsTarget = `${B}\n# AGENTS.md\n\nold managed guidance\n${E}\n\n## Project docs\n\nrepo-local instructions\n`;

export const gitignoreManagedNew = `${HB}\n*.new\n${HE}\n`;
export const gitignoreRender = `# local patterns go above the managed region\n\n${gitignoreManagedNew}`;
export const gitignoreTarget = `# local patterns go above the managed region\n/repo-local-cache/\nsecret.env\n\n${HB}\n*.old\n${HE}\n`;

export const contributingRender = `${B}\n# Contributing\n\nfresh managed prefix\n${E}\n`;
export const contributingTarget = `${B}\n# Contributing\n\nold managed prefix\n${E}\n\n## Local dev setup\n\nrun the local thing\n`;

export function gitFreeEnv(): Record<string, string> {
  // Hook-driven runs (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE, which
  // would redirect every git subprocess these tests spawn away from their
  // scratch repositories.
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

export function initGitRepo(dir: string): void {
  const run = (...args: string[]) => {
    const proc = boundedSpawnSync(["git", "-C", dir, ...args], { env: gitFreeEnv() });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
    }
  };
  run("init", "-b", "main");
  run("config", "user.name", "test");
  run("config", "user.email", "test@example.com");
  run("add", "-A");
  run("commit", "-qm", "pre-render state");
}

export function runScript(
  root: string,
  extraArgs: string[] = [],
): { exitCode: number; stdout: string; stderr: string; summary: string } {
  const summaryPath = join(root, "..", "local-carryover.md");
  const proc = boundedSpawnSync(
    ["bun", script, "--summary", summaryPath, "--root", root, ...extraArgs],
    { env: gitFreeEnv() },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    summary: existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8") : "",
  };
}

export const RECOPY_ENTRIES: SplitSpec[] = [
  AGENTS_MARKERS,
  { path: ".gitignore", begin: HB, end: HE },
  { path: "CONTRIBUTING.md", begin: B, end: E },
  { path: "SECURITY.md", begin: B, end: E },
  { path: ".editorconfig", begin: HB, end: HE },
  { path: ".github/CODEOWNERS", begin: HB, end: HE },
];

// Render mode's fixed inputs: the old render's managed regions and the
// merge junk every render-mode fixture plants in the working tree.
export const agentsOld = `${B}\n# AGENTS.md\n\nold managed guidance\n${E}\n`;
export const gitignoreOldRender = `# local patterns go above the managed region\n\n${HB}\n*.old\n${HE}\n`;
export const MERGE_JUNK = "merged result to discard\n";
export const GITIGNORE_MARKERS: SplitSpec = { path: ".gitignore", begin: HB, end: HE };

export function runRender(root: string, renderDir: string, oldRenderDir: string) {
  const reviewPath = join(root, "..", "carry-review.txt");
  const rebuiltPath = join(root, "..", "rebuilt-paths.txt");
  const result = runScript(root, [
    "--render-dir",
    renderDir,
    "--old-render-dir",
    oldRenderDir,
    "--needs-review",
    reviewPath,
    "--rebuilt-paths",
    rebuiltPath,
  ]);
  return {
    ...result,
    review: existsSync(reviewPath) ? readFileSync(reviewPath, "utf-8") : "",
    rebuilt: existsSync(rebuiltPath) ? readFileSync(rebuiltPath, "utf-8") : "",
  };
}

/** The builders that make scratch directories, bound to the calling file's
 * TempDirs: bun:test hooks belong to the registering file, so the fixture
 * owner (and its afterAll) has to live in each test file. */
export function scratchFixtures(temp: TempDirs) {
  /** A target checkout's files. Every managed repository carries an
   * ownership manifest at HEAD (a fixture without one models the state the
   * carry refuses as unusable), so a fixture that names none gets the
   * standard split declarations. */
  function makeTarget(
    given: Record<string, string>,
    options: { headManifest?: false } = {},
  ): string {
    const files =
      MANIFEST_REL in given || options.headManifest === false
        ? given
        : { [MANIFEST_REL]: manifestJson(RECOPY_ENTRIES), ...given };
    const base = temp.dir("preserve-local-");
    const root = join(base, "target");
    mkdirSync(root);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return root;
  }

  function makeRenderPair(
    entries: SplitSpec[],
    newFiles: Record<string, string>,
    oldFiles: Record<string, string>,
  ): { renderDir: string; oldRenderDir: string } {
    const base = temp.dir("preserve-render-");
    const renderDir = join(base, "render-new");
    const oldRenderDir = join(base, "render-old");
    for (const [dir, files] of [
      [renderDir, { ...newFiles, [MANIFEST_REL]: manifestJson(entries) }],
      [oldRenderDir, oldFiles],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
    }
    return { renderDir, oldRenderDir };
  }

  return { makeTarget, makeRenderPair };
}
