import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  carryManagedRegion,
  fencedResetExcerpt,
  splitEntries,
} from "../../.github/scripts/sync/preserve_local_content.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/preserve_local_content.ts");
const repoRoot = join(import.meta.dir, "..", "..");

// The one marker vocabulary (actions/shared/grammar.ts).
const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
const E = "<!-- END REPO-PLATFORM MANAGED -->";
const HB = "# BEGIN REPO-PLATFORM MANAGED";
const HE = "# END REPO-PLATFORM MANAGED";

// The RETIRED grammars' spellings: the fixtures below use them to prove
// that a straggler repo still carrying an old shape (or an old-vintage
// manifest) gets the loud fail-closed path, never a conversion - the
// one-time conversion machinery is deleted (fleet censused
// post-conversion).
const OLD_SENTINEL = "<!-- repo-platform:local-section -->";
const OLD_LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
// The retired .gitignore guidance line, verbatim: with the conversion
// strip deleted, a repo-owned side holding it keeps it byte-identical.
const OLD_GUIDANCE = "# Add repository-specific ignore patterns in this section only.";

const MANIFEST_REL = ".github/repo-platform-manifest.json";

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
function htmlAppendixCarry(render: string, previous: string): string {
  const neutralized = previous
    .replaceAll(B, "<!---BEGIN-REPO-PLATFORM-MANAGED--->")
    .replaceAll(E, "<!---END-REPO-PLATFORM-MANAGED--->");
  return `${render}\n${HTML_APPENDIX}\n\n${neutralized}`;
}

interface SplitSpec {
  path: string;
  begin: string;
  end: string;
}

/** A manifest carrying the given split entries, in the shape
 * compose_template.ts emits (one grammar: managed-region, begin/end). */
function manifestJson(entries: SplitSpec[]): string {
  return JSON.stringify({
    files: Object.fromEntries(
      entries.map((e) => [
        e.path,
        { class: "split", grammar: "managed-region", begin: e.begin, end: e.end, hash: null },
      ]),
    ),
  });
}

/** A RETIRED-vintage manifest, exactly as the old compose emitted the
 * tail-marker wire - what a straggler repo's HEAD would still carry. The
 * sync no longer reads it: headSplitEntries refuses, and the carry falls
 * back to the new entries' markers with the appendix behind them. */
function legacyManifestJson(entries: { path: string; marker: string }[]): string {
  return JSON.stringify({
    files: Object.fromEntries(
      entries.map((e) => [
        e.path,
        { class: "split", grammar: "tail-marker", marker: e.marker, managed: "above", hash: null },
      ]),
    ),
  });
}

const AGENTS_MARKERS: SplitSpec = { path: "AGENTS.md", begin: B, end: E };
const agentsRender = `${B}\n# AGENTS.md\n\nfresh managed guidance\n${E}\n`;
const agentsTarget = `${B}\n# AGENTS.md\n\nold managed guidance\n${E}\n\n## Project docs\n\nrepo-local instructions\n`;

const gitignoreManagedNew = `${HB}\n*.new\n${HE}\n`;
const gitignoreRender = `# local patterns go above the managed region\n\n${gitignoreManagedNew}`;
const gitignoreTarget = `# local patterns go above the managed region\n/repo-local-cache/\nsecret.env\n\n${HB}\n*.old\n${HE}\n`;

const contributingRender = `${B}\n# Contributing\n\nfresh managed prefix\n${E}\n`;
const contributingTarget = `${B}\n# Contributing\n\nold managed prefix\n${E}\n\n## Local dev setup\n\nrun the local thing\n`;

const editorconfigRender = `${HB}\nroot = true\n\n[*]\ncharset = utf-8\n${HE}\n`;
const editorconfigTarget = `${HB}\nroot = true\n\n[*]\nend_of_line = lf\n${HE}\n\n[legacy/**.js]\nindent_size = 3\n`;

const codeownersRender = `${HB}\n* @vivswan\n${HE}\n`;
const codeownersTarget = `${HB}\n* @oldname\n${HE}\n\n/security/ @security-team\n`;

const asEntry = (spec: SplitSpec) =>
  ({ path: spec.path, grammar: "managed-region", begin: spec.begin, end: spec.end }) as const;

const headOf = (spec: SplitSpec) => ({ path: spec.path, begin: spec.begin, end: spec.end });

describe("carryManagedRegion", () => {
  test("unchanged managed region keeps the target byte-identical (both sides)", () => {
    const target = `above notes\n${contributingRender}\n## Local dev setup\n\nrepo tail\n`;
    const carry = carryManagedRegion(
      contributingRender,
      target,
      asEntry({ path: "CONTRIBUTING.md", begin: B, end: E }),
      headOf({ path: "CONTRIBUTING.md", begin: B, end: E }),
    );
    expect(carry).toEqual({ kind: "sides-restored", content: target });
  });

  test("diverged managed region restores the target's sides around the fresh render", () => {
    const carry = carryManagedRegion(
      contributingRender,
      contributingTarget,
      asEntry({ path: "CONTRIBUTING.md", begin: B, end: E }),
      undefined,
    );
    expect(carry).toEqual({
      kind: "sides-restored",
      content: `${contributingRender}\n## Local dev setup\n\nrun the local thing\n`,
    });
  });

  test("content ABOVE the region round-trips (the both-sides capability)", () => {
    const target = `repo-owned preamble\n\n${B}\nold managed\n${E}\nrepo tail\n`;
    const render = `${B}\nnew managed\n${E}\n`;
    const carry = carryManagedRegion(render, target, asEntry(AGENTS_MARKERS), undefined);
    expect(carry).toEqual({
      kind: "sides-restored",
      content: `repo-owned preamble\n\n${B}\nnew managed\n${E}\nrepo tail\n`,
    });
  });

  test("identical target keeps the render", () => {
    expect(
      carryManagedRegion(
        contributingRender,
        contributingRender,
        asEntry({ path: "CONTRIBUTING.md", begin: B, end: E }),
        undefined,
      ),
    ).toBeNull();
  });

  test("a target with empty sides delivers exactly the render", () => {
    const target = `${B}\nold managed\n${E}\n`;
    expect(carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined)).toBeNull();
  });

  test("a whitespace-only side is carried, not silently dropped", () => {
    // The sides are byte-owned by the repository: even blanks outside the
    // region ride through rather than vanish without a disposition.
    const target = `${B}\nold managed\n${E}\n\n`;
    expect(carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined)).toEqual({
      kind: "sides-restored",
      content: `${agentsRender}\n`,
    });
  });

  test("an UNUSABLE HEAD manifest forces the appendix even when the copy splits at the new markers", () => {
    // The misattribution hazard: an old-shaped copy whose repo-owned tail
    // happens to carry one clean current marker pair would split
    // "honestly" at the new markers - and hand the repo-owned bytes
    // between them to the managed discard. With HEAD's declarations
    // unusable, no split may be guessed: keep BOTH, every byte reviewable.
    const target = `old managed top\n${OLD_SENTINEL}\ntail intro\n${B}\nREPO-OWNED SECRET\n${E}\ntail outro\n`;
    const carry = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), "unusable");
    expect(carry?.kind).toBe("appendix");
    expect(carry?.content).toContain("REPO-OWNED SECRET");
    // Contrast: with a USABLE manifest that simply lacks the declaration,
    // the same copy splits at the new markers (an ownership flip's carry).
    const flipped = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined);
    expect(flipped?.kind).toBe("sides-restored");
  });

  test("a relic-shaped line the repo owns is NEVER stripped (the conversion strip is gone)", () => {
    // Post-census scope: retired spellings in repo-owned space are the
    // repository's bytes, kept byte-identical on every sync, forever.
    const target = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n/repo-local-cache/\n\n${HB}\n*.old\n${HE}\n`;
    const carry = carryManagedRegion(
      gitignoreRender,
      target,
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      headOf({ path: ".gitignore", begin: HB, end: HE }),
    );
    expect(carry).toEqual({
      kind: "sides-restored",
      content: `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n/repo-local-cache/\n\n${gitignoreManagedNew}`,
    });
  });

  test.each([
    {
      reason: "a marker-less copy, HEAD's manifest usable but not declaring the path",
      previous: "# AGENTS.md\n\nold managed guidance\n\n## Project docs\n\nrepo-local notes\n",
      headDecl: undefined,
    },
    {
      // STRAGGLER: the one-time conversion is deleted, so an old
      // tail-marker-shaped copy (whose manifest headSplitEntries refuses)
      // has no trustworthy split - loud, manual review, zero repo-owned
      // bytes lost.
      reason: "a retired-sentinel copy under an unusable HEAD manifest",
      previous: `# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`,
      headDecl: "unusable" as const,
    },
  ])(
    "an unsplittable previous copy is kept whole below a marked appendix: $reason",
    ({ previous, headDecl }) => {
      expect(carryManagedRegion(agentsRender, previous, asEntry(AGENTS_MARKERS), headDecl)).toEqual(
        {
          kind: "appendix",
          content: htmlAppendixCarry(agentsRender, previous),
        },
      );
    },
  );

  test("a blank previous copy has nothing to preserve and keeps the render", () => {
    expect(carryManagedRegion(agentsRender, "\n\n", asEntry(AGENTS_MARKERS), undefined)).toBeNull();
  });

  test("a render without a clean region throws (manifest and render disagree)", () => {
    expect(() =>
      carryManagedRegion("no markers here\n", agentsTarget, asEntry(AGENTS_MARKERS), undefined),
    ).toThrow("manifest and render disagree");
  });

  test.each([
    {
      reason: "a second BEGIN/END pair (any slice would guess which region is managed)",
      target: `${B}\nfirst\n${E}\n${B}\nsecond\n${E}\n`,
    },
    {
      reason: "BEGIN text buried mid-line counts as a duplicate (substring semantics)",
      target: `mention: ${B}\n${B}\nold\n${E}\nrepo tail\n`,
    },
    {
      reason: "END text only mid-line: no END marker line closes the region",
      target: `${B}\nold managed\nmention: ${E} mid-line\n`,
    },
  ])(
    "a copy without exactly one whole-line marker pair takes the appendix, every marker occurrence neutralized: $reason",
    ({ target }) => {
      // Exactly-once whole-line markers or appendix - and the delivered
      // file keeps exactly ONE occurrence of each marker (the render's),
      // or the validator's exactly-once rule rejects the recovery output
      // with advice pointing away from the real cause.
      expect(carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined)).toEqual({
        kind: "appendix",
        content: htmlAppendixCarry(agentsRender, target),
      });
    },
  );

  test("hash-marker appendixes use hash comments, not an HTML comment", () => {
    const carry = carryManagedRegion(
      gitignoreRender,
      "legacy patterns, no markers\n",
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      undefined,
    );
    expect(carry?.kind).toBe("appendix");
    expect(carry?.content).toContain("# repo-platform:recovery-appendix");
    expect(carry?.content).not.toContain("<!--");
  });

  test("a second recovery over an appendix result is stable (single appendix)", () => {
    const legacy = "old copy without markers\nrepo-local notes\n";
    const first = carryManagedRegion(agentsRender, legacy, asEntry(AGENTS_MARKERS), undefined);
    expect(first?.kind).toBe("appendix");
    const second = carryManagedRegion(
      agentsRender,
      first?.content ?? "",
      asEntry(AGENTS_MARKERS),
      undefined,
    );
    expect(second?.kind).toBe("sides-restored");
    expect(second?.content).toBe(first?.content ?? "");
    expect(second?.content.split("repo-platform:recovery-appendix").length).toBe(2);
  });

  test("markers whose neutralized forms collide fail loudly, never invalidly", () => {
    // "# A-B" dash-joins to "#-A-B" - recreating the BEGIN marker after
    // BEGIN was already neutralized: the postcondition must refuse to
    // deliver a file the validator's exactly-once rule rejects. The
    // declaration schema forbids such pairs; this is the backstop for
    // hostile manifest text.
    const entry = { path: "x", grammar: "managed-region", begin: "#-A-B", end: "# A-B" } as const;
    const render = "#-A-B\nmanaged\n# A-B\n";
    expect(() =>
      carryManagedRegion(render, "no clean split, has # A-B text\n", entry, undefined),
    ).toThrow("collide under neutralization");
  });

  test.each([
    {
      reason: "a stray trailing space",
      render: agentsRender,
      target: `${B} \nold managed\n${E}\nrepo tail\n`,
      expected: `${agentsRender}repo tail\n`,
    },
    {
      reason: "a leading indent",
      render: agentsRender,
      target: `above\n  ${B}\nold\n${E}\nrepo tail\n`,
      expected: `above\n${agentsRender}repo tail\n`,
    },
    {
      reason: "CRLF line endings (the sides keep their bytes)",
      render: `${B}\r\ndocs\r\n${E}\r\n`,
      target: `${B}\r\nold\r\n${E}\r\nrepo tail\r\n`,
      expected: `${B}\r\ndocs\r\n${E}\r\nrepo tail\r\n`,
    },
  ])(
    "a marker line anchors the split under trim semantics: $reason",
    ({ render, target, expected }) => {
      // isMarkerLine trims; the stamper and the validator already counted
      // the decorated line as the marker line, and the SUBSTRING
      // exactly-once rule still holds, so the region slices cleanly.
      expect(carryManagedRegion(render, target, asEntry(AGENTS_MARKERS), undefined)).toEqual({
        kind: "sides-restored",
        content: expected,
      });
    },
  );

  test("a render whose END line has no trailing newline still joins cleanly", () => {
    const render = `${B}\ndocs\n${E}`;
    const target = `${B}\nold\n${E}\nrepo tail\n`;
    expect(carryManagedRegion(render, target, asEntry(AGENTS_MARKERS), undefined)).toEqual({
      kind: "sides-restored",
      content: `${B}\ndocs\n${E}\nrepo tail\n`,
    });
  });
});

function gitFreeEnv(): Record<string, string> {
  // Hook-driven runs (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE, which
  // would redirect every git subprocess these tests spawn away from their
  // scratch repositories.
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function initGitRepo(dir: string): void {
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

function runScript(
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

function makeTarget(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "preserve-local-"));
  const root = join(base, "target");
  mkdirSync(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

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

const RECOPY_ENTRIES: SplitSpec[] = [
  AGENTS_MARKERS,
  { path: ".gitignore", begin: HB, end: HE },
  { path: "CONTRIBUTING.md", begin: B, end: E },
  { path: "SECURITY.md", begin: B, end: E },
  { path: ".editorconfig", begin: HB, end: HE },
  { path: ".github/CODEOWNERS", begin: HB, end: HE },
];

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

  test("a recopy over a retired-vintage repo takes the appendix, never a conversion", () => {
    // HEAD still carries the old tail-marker shape and manifest: the
    // refused manifest makes HEAD's declarations unusable, so the whole
    // previous copy is preserved below the appendix - a recovery sync is
    // exactly where a straggler lands. The repo-owned tail carries one
    // clean CURRENT marker pair on purpose: a carry that ignored the
    // refused manifest would split there "honestly" and hand the bytes
    // between the markers to the managed discard.
    const oldShape = `# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\ntail intro\n${B}\nREPO-OWNED SECRET\n${E}\ntail outro\n`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([{ path: "AGENTS.md", marker: OLD_SENTINEL }]),
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

describe("splitEntries", () => {
  const regionEntry = (over: Record<string, unknown> = {}) => ({
    class: "split",
    grammar: "managed-region",
    begin: B,
    end: E,
    hash: null,
    ...over,
  });

  test("returns the split entries with the grammar's declaration shape", () => {
    const manifest = JSON.stringify({
      files: {
        "AGENTS.md": regionEntry(),
        ".gitignore": regionEntry({ begin: HB, end: HE }),
        ".github/workflows/ci.yml": { class: "managed", hash: null },
        ".github/workflows/checks.yml": { class: "starter" },
      },
    });
    expect(splitEntries(manifest, "m")).toEqual([
      { path: "AGENTS.md", grammar: "managed-region", begin: B, end: E },
      { path: ".gitignore", grammar: "managed-region", begin: HB, end: HE },
    ]);
  });

  test("throws on a split entry with no grammar (a pre-grammar manifest)", () => {
    const manifest = JSON.stringify({
      files: { "AGENTS.md": { class: "split", begin: B, end: E, hash: null } },
    });
    expect(() => splitEntries(manifest, "m")).toThrow("declares no grammar");
  });

  test("throws on an unknown grammar instead of degrading", () => {
    // Registered in scripts/guard_registry.ts
    // (split-entries-unknown-grammar-refusal). The RETIRED grammars are
    // unknown too: the fresh render's manifest is generated by this
    // change's own compose and the conversion machinery is deleted, so a
    // retired grammar anywhere is damage, never a shape to read.
    for (const grammar of ["prefix", "tail-marker", "bounded-region"]) {
      const manifest = JSON.stringify({
        files: { "AGENTS.md": regionEntry({ grammar }) },
      });
      expect(() => splitEntries(manifest, "m")).toThrow(`unknown grammar "${grammar}"`);
    }
  });

  test("throws on a missing or non-ASCII marker string", () => {
    const missing = JSON.stringify({
      files: { "AGENTS.md": { class: "split", grammar: "managed-region", begin: B, hash: null } },
    });
    expect(() => splitEntries(missing, "m")).toThrow("printable-ASCII");
    const nonAscii = JSON.stringify({
      files: { "AGENTS.md": regionEntry({ begin: "# local § begin" }) },
    });
    expect(() => splitEntries(nonAscii, "m")).toThrow("printable-ASCII");
  });

  test("throws on a split path that could escape the target root", () => {
    for (const path of ["../victim", "a/../../victim", "/etc/victim", "a//b"]) {
      const manifest = JSON.stringify({ files: { [path]: regionEntry() } });
      expect(() => splitEntries(manifest, "m")).toThrow("not a clean relative path");
    }
  });

  test("throws on non-JSON input and on a files-less document", () => {
    expect(() => splitEntries("not json", "m")).toThrow("does not parse as a manifest");
    expect(() => splitEntries("{}", "m")).toThrow("no top-level 'files' mapping");
  });

  test("a duplicated key throws instead of last-win laundering", () => {
    // Raw JSON.parse keeps the LAST value silently: a duplicated class
    // field would declassify a split entry out of every carry with no
    // error. The shared parser rejects the duplicate before any read.
    const doubled = '{"files": {"AGENTS.md": {"class": "split", "class": "starter"}}}';
    expect(() => splitEntries(doubled, "m")).toThrow("binds a key more than once");
  });

  test("an array-shaped files value fails loud, never open", () => {
    // '"files": []' passes `typeof === "object"` and would yield ZERO
    // entries - every carry would silently skip after recopy already
    // overwrote local content.
    expect(() => splitEntries('{"files": []}', "m")).toThrow("no top-level 'files' mapping");
    const arrayEntry = JSON.stringify({ files: { "AGENTS.md": [] } });
    expect(() => splitEntries(arrayEntry, "m")).toThrow("is not an object");
  });

  // The appendix writes comments in the markers' syntax, and the manifest
  // text is attacker-adjacent at this boundary: it is whatever the target
  // repo's stamped file claims, so the one-comment rule has to hold here
  // and not just at declaration time.
  test.each([
    { reason: "a non-comment marker", begin: "// begin managed" },
    { reason: "two HTML comments on one marker", begin: "<!-- closed --> active <!-- final -->" },
    { reason: "a degenerate HTML opener", begin: "<!-->" },
  ])("throws on a marker that is not one hash or HTML comment: $reason", ({ begin }) => {
    const manifest = JSON.stringify({ files: { "AGENTS.md": regionEntry({ begin }) } });
    expect(() => splitEntries(manifest, "m")).toThrow(
      "not a hash comment or a complete HTML comment",
    );
  });

  test("throws on markers that contain each other (substring counting)", () => {
    const manifest = JSON.stringify({
      files: { "AGENTS.md": regionEntry({ begin: "# MANAGED", end: "# MANAGED END" }) },
    });
    expect(() => splitEntries(manifest, "m")).toThrow("substring-free");
  });
});

// Every split template source must carry its declared BEGIN/END markers
// exactly once, in order - the composer enforces this via
// declarationTextErrors; this is the fast regression net for the template
// files themselves.
describe("split templates carry one ordered marker pair", () => {
  test("each split source has BEGIN before END, each exactly once", () => {
    const templatesDir = join(repoRoot, "templates");
    const templated: [string, string, string][] = [
      [join(templatesDir, "base", "{% if not private %}CONTRIBUTING.md{% endif %}.jinja"), B, E],
      [join(templatesDir, "base", "SECURITY.md.jinja"), B, E],
      [
        join(
          templatesDir,
          "base",
          "{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja",
        ),
        B,
        E,
      ],
      [join(templatesDir, "base", ".gitattributes.jinja"), HB, HE],
      [join(templatesDir, "base", ".editorconfig.jinja"), HB, HE],
      [join(templatesDir, "base", ".github", "CODEOWNERS.jinja"), HB, HE],
      [join(templatesDir, "base", ".gitignore.jinja"), HB, HE],
      [join(templatesDir, "agents", "AGENTS.md.jinja"), B, E],
    ];
    for (const [path, begin, end] of templated) {
      const source = readFileSync(path, "utf-8");
      expect(source.split(begin).length).toBe(2);
      expect(source.split(end).length).toBe(2);
      expect(source.indexOf(begin)).toBeLessThan(source.indexOf(end));
    }
  });
});

// Render mode: the primary sync path. The working tree holds copier's
// MERGED result, which the rebuild must DISCARD - every fixture below
// plants junk there to prove the output comes from (render-new, HEAD)
// only. HEAD is the committed pre-update state; render-old/render-new are
// clean renders at the old and new template refs.
describe("preserve_local_content render mode", () => {
  const agentsOld = `${B}\n# AGENTS.md\n\nold managed guidance\n${E}\n`;
  const securityOld = `${B}\nold security prefix\n${E}\n`;
  const securityNew = `${B}\nfresh security prefix\n${E}\n`;
  const gitignoreOldRender = `# local patterns go above the managed region\n\n${HB}\n*.old\n${HE}\n`;
  const MERGE_JUNK = "merged result to discard\n";
  const SECURITY_MARKERS: SplitSpec = { path: "SECURITY.md", begin: B, end: E };
  const GITIGNORE_MARKERS: SplitSpec = { path: ".gitignore", begin: HB, end: HE };

  function makeRenderPair(
    entries: SplitSpec[],
    newFiles: Record<string, string>,
    oldFiles: Record<string, string>,
  ): { renderDir: string; oldRenderDir: string } {
    const base = mkdtempSync(join(tmpdir(), "preserve-render-"));
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

  function runRender(root: string, renderDir: string, oldRenderDir: string) {
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

  test("STRAGGLER: a tail-marker repo gets the appendix and a review hold, never a conversion", () => {
    // HEAD state: old-shape file + old-vintage manifest - a straggler the
    // census says should not exist. The refused manifest yields no HEAD
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
      [MANIFEST_REL]: legacyManifestJson([{ path: "AGENTS.md", marker: OLD_SENTINEL }]),
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

  test("STRAGGLER: an old .gitignore takes the appendix too, its relic lines preserved", () => {
    // The old bounded shape carries the current BEGIN/END pair inside its
    // managed half, so it WOULD split at the new markers - but HEAD's
    // refused manifest makes every declaration untrustworthy, and a
    // guessed split is exactly the misattribution hazard. The whole copy
    // rides the appendix, retired relic lines included (they are repo
    // bytes now; the conversion strip is deleted).
    const above = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n/repo-local-cache/\nsecret.env\n\n`;
    const oldHead = `${above}${HB}\n*.old\n${HE}\n`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([{ path: ".gitignore", marker: HB }]),
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

  test("a STEADY-STATE sync of a relic-spelling .gitignore strips nothing, ever", () => {
    // The conversion strip is deleted: a repo-owned side that happens to
    // hold a retired spelling keeps it byte-identical on every sync.
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
    const outside = mkdtempSync(join(tmpdir(), "preserve-outside-"));
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
    const base = mkdtempSync(join(tmpdir(), "preserve-render-"));
    mkdirSync(join(base, "render-new"));
    mkdirSync(join(base, "render-old"));
    const result = runRender(root, join(base, "render-new"), join(base, "render-old"));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("needs the new render's manifest");
  });

  test("a pre-grammar RENDER manifest fails loudly instead of guessing the carry", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const base = mkdtempSync(join(tmpdir(), "preserve-render-"));
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

  test("--render-dir without --old-render-dir is rejected", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const result = runScript(root, ["--render-dir", root]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--render-dir and --old-render-dir come together");
  });
});

// End-to-end against a REAL template render and a REAL `copier recopy
// --overwrite`, mirroring reusable-template-sync.yml's recovery path:
// build a scratch template tree, generate a repo from it, customize the
// sanctioned repo-owned sides, commit, recopy (which resets them - the
// live defect), then assert the carry restores every side. Requires
// copier on PATH, so it runs where copier exists (locally and on the sync
// runner); CI's script-tests job skips it, and the always-on CI coverage
// is upgrade_path_test.sh's recovery leg, which drives the same carry
// against a real recopy in the upgrade-path job.
const hasCopier = Bun.which("copier") !== null;

describe.skipIf(!hasCopier)("preserve_local_content end-to-end (copier recopy)", () => {
  test(
    "restores the repo-owned sides a recovery re-render wipes",
    () => {
      const base = mkdtempSync(join(tmpdir(), "preserve-local-e2e-"));
      const tree = join(base, "bt");
      const target = join(base, "out");
      // Only the copier renders need a wide bound; everything else keeps
      // the wrapper's default, and both stay under the test's 300s cap
      // so a wedge dies named.
      const COPIER_TIMEOUT_MS = 270_000;
      const run = (cmd: string[], cwd?: string, timeoutMs?: number) => {
        const proc = boundedSpawnSync(cmd, { cwd, env: gitFreeEnv(), timeoutMs });
        if (proc.exitCode !== 0) {
          throw new Error(`${cmd.join(" ")} failed:\n${proc.stdout}\n${proc.stderr}`);
        }
        return proc.stdout;
      };
      run(["bun", join(repoRoot, ".github/scripts/build-branches/branch_tree.ts"), "--dest", tree]);
      run(["git", "-C", tree, "init", "-b", "build"]);
      run(["git", "-C", tree, "add", "-A"]);
      run(["git", "-C", tree, "-c", "user.name=t", "-c", "user.email=t@e.c", "commit", "-qm", "b"]);
      const copierArgs = [
        "--defaults",
        "--trust",
        "-d",
        "project_name=X",
        "-d",
        "description=Y",
        "-d",
        "modules=[agents, uv]",
        "-d",
        "private=false",
      ];
      run(
        ["copier", "copy", tree, target, "--vcs-ref", "HEAD", ...copierArgs],
        undefined,
        COPIER_TIMEOUT_MS,
      );

      // Customize every sanctioned repo-owned side, plus the repo-owned
      // exemptions file, and commit: this is the pre-recovery repo state.
      const tails: Record<string, string> = {
        "AGENTS.md": "\n## Project docs\n\nrepo-local agent guidance\n",
        "CONTRIBUTING.md": "\n## Local dev setup\n\nbun install && bun test\n",
        "SECURITY.md": "\n## Scope\n\nrepo-local threat model\n",
        "LICENSE.md": "\nThird-party components: repo-local notice\n",
        ".gitattributes": "*.repo-local binary\n",
        ".editorconfig": "\n[legacy/**.js]\nindent_size = 3\n",
        ".github/CODEOWNERS": "\n/security/ @security-team\n",
      };
      for (const [rel, tail] of Object.entries(tails)) {
        const path = join(target, rel);
        writeFileSync(path, readFileSync(path, "utf-8") + tail);
      }
      // .gitignore: local content lives ABOVE the managed BEGIN marker.
      const gitignorePath = join(target, ".gitignore");
      writeFileSync(
        gitignorePath,
        readFileSync(gitignorePath, "utf-8").replace(`${HB}\n`, `/repo-local-cache/\n\n${HB}\n`),
      );
      writeFileSync(join(target, ".typography-allow.local"), "docs/legacy/\n");
      initGitRepo(target);

      // The recovery re-render, exactly as apply_update.ts issues it.
      run(
        [
          "copier",
          "recopy",
          "--overwrite",
          // Where copier reads the recorded answers: the CLI flag or the
          // hardcoded root default, never the template's _answers_file -
          // the same flag apply_update.ts passes.
          "--answers-file",
          ".github/.copier-answers.yml",
          "--vcs-ref",
          "HEAD",
          ...copierArgs,
        ],
        target,
        COPIER_TIMEOUT_MS,
      );
      // Defect reproduced: the re-render reset the repo-owned sides.
      expect(readFileSync(join(target, "AGENTS.md"), "utf-8")).not.toContain(
        "repo-local agent guidance",
      );
      expect(readFileSync(gitignorePath, "utf-8")).not.toContain("/repo-local-cache/");
      // recopy deletes nothing: the separate repo-owned file survives.
      expect(existsSync(join(target, ".typography-allow.local"))).toBe(true);

      const summaryPath = join(base, "local-carryover.md");
      run(["bun", script, "--summary", summaryPath, "--root", target]);

      for (const [rel, tail] of Object.entries(tails)) {
        expect(readFileSync(join(target, rel), "utf-8")).toEndWith(tail);
      }
      expect(readFileSync(join(target, "AGENTS.md"), "utf-8")).toContain(E);
      expect(readFileSync(gitignorePath, "utf-8")).toContain("/repo-local-cache/");
      const summary = readFileSync(summaryPath, "utf-8");
      for (const rel of [...Object.keys(tails), ".gitignore"]) {
        expect(summary).toContain(`- \`${rel}\`:`);
      }
      // The whole carried tree must still validate.
      const validate = boundedSpawnSync([
        "bun",
        join(repoRoot, "actions/validate-template/validate_generated_files.ts"),
        target,
      ]);
      expect(validate.exitCode).toBe(0);
    },
    { timeout: 300000 },
  );
});
