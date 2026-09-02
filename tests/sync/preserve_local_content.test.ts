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

// The RETIRED grammars' spellings, for the transition fixtures: fleet
// repos still carry these shapes until their first post-change sync.
const OLD_SENTINEL = "<!-- repo-platform:local-section -->";
const OLD_LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
const OLD_LOCAL_END = "# END REPOSITORY LOCAL";
// The retired .gitignore guidance line, verbatim: platform-authored text
// the one grammar makes FALSE (there is no "this section" anymore), so
// the conversion strips it with the retired markers.
const OLD_GUIDANCE = "# Add repository-specific ignore patterns in this section only.";

const MANIFEST_REL = ".github/repo-platform-manifest.json";

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

/** A manifest of the RETIRED vintages, exactly as the old compose emitted
 * them (the legacy marker/managed wire pair) - what a fleet repo's HEAD
 * still carries on the transition sync. */
function legacyManifestJson(
  entries: { path: string; grammar: "tail-marker" | "bounded-region"; marker: string }[],
): string {
  return JSON.stringify({
    files: Object.fromEntries(
      entries.map((e) => [
        e.path,
        e.grammar === "tail-marker"
          ? { class: "split", grammar: e.grammar, marker: e.marker, managed: "above", hash: null }
          : {
              class: "split",
              grammar: e.grammar,
              marker: e.marker,
              managed: "below",
              managed_end: HE,
              local_begin: OLD_LOCAL_BEGIN,
              local_end: OLD_LOCAL_END,
              hash: null,
            },
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

const headOf = (spec: SplitSpec) =>
  ({ vintage: "managed-region", path: spec.path, begin: spec.begin, end: spec.end }) as const;

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

  test("the tail-marker transition: the repo tail lands below END, byte-identical", () => {
    const oldShape = `# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`;
    const carry = carryManagedRegion(agentsRender, oldShape, asEntry(AGENTS_MARKERS), {
      vintage: "tail-marker",
      path: "AGENTS.md",
      marker: OLD_SENTINEL,
    });
    expect(carry).toEqual({
      kind: "converted",
      content: `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
      from: "tail-marker",
      extraMarkers: false,
      stripped: [],
      blanksCollapsed: 0,
    });
  });

  test("the tail-marker transition with an EMPTY tail keeps the render", () => {
    const oldShape = `# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\n`;
    expect(
      carryManagedRegion(agentsRender, oldShape, asEntry(AGENTS_MARKERS), {
        vintage: "tail-marker",
        path: "AGENTS.md",
        marker: OLD_SENTINEL,
      }),
    ).toBeNull();
  });

  test("the old bounded-region transition: everything above the BEGIN line rides through", () => {
    const oldShape = `${OLD_LOCAL_BEGIN}\n/repo-local-cache/\n${OLD_LOCAL_END}\n\n${HB}\n*.old\n${HE}\n`;
    const carry = carryManagedRegion(
      gitignoreRender,
      oldShape,
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      { vintage: "bounded-region", path: ".gitignore", managed_begin: HB },
    );
    // The repository's OWN line rides through; the retired LOCAL marker
    // pair does not - it is platform-authored relic text the one grammar
    // no longer splits at, subtracted by the conversion and named in the
    // note.
    expect(carry).toEqual({
      kind: "converted",
      content: `/repo-local-cache/\n\n${gitignoreManagedNew}`,
      from: "bounded-region",
      extraMarkers: false,
      stripped: [OLD_LOCAL_BEGIN, OLD_LOCAL_END],
      blanksCollapsed: 0,
    });
  });

  test("the conversion strips the retired guidance line, keeping a repo LOOKALIKE", () => {
    // The relic set is exact full lines: the retired guidance goes, a line
    // the repository wrote that merely resembles it survives byte-identical.
    const lookalike = "# Add repository-specific ignore patterns here please";
    const oldShape =
      `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n${lookalike}\n/repo-local-cache/\n` +
      `${OLD_LOCAL_END}\n\n${HB}\n*.old\n${HE}\n`;
    const carry = carryManagedRegion(
      gitignoreRender,
      oldShape,
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      { vintage: "bounded-region", path: ".gitignore", managed_begin: HB },
    );
    expect(carry).toEqual({
      kind: "converted",
      content: `${lookalike}\n/repo-local-cache/\n\n${gitignoreManagedNew}`,
      from: "bounded-region",
      extraMarkers: false,
      stripped: [OLD_LOCAL_BEGIN, OLD_GUIDANCE, OLD_LOCAL_END],
      blanksCollapsed: 0,
    });
  });

  test("a STEADY-STATE sync never strips a relic-shaped line the repo owns", () => {
    // Scope: the strip belongs to the conversion alone. An
    // already-converted file whose repo-owned side happens to hold a
    // retired spelling keeps it byte-identical, forever.
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

  test("a converted side of nothing but relics collapses without a leading blank", () => {
    // The stock old .gitignore LOCAL block was ALL platform boilerplate:
    // after the strip the file opens on its managed region, not on a blank.
    const oldShape = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n${OLD_LOCAL_END}\n\n${HB}\n*.old\n${HE}\n`;
    const carry = carryManagedRegion(
      gitignoreRender,
      oldShape,
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      { vintage: "bounded-region", path: ".gitignore", managed_begin: HB },
    );
    expect(carry?.content).toBe(gitignoreManagedNew);
  });

  test("a strip that leaves the render's bytes still REPORTS - it never returns null", () => {
    // The common fleet .gitignore: an all-boilerplate LOCAL block above a
    // managed half already equal to the render. The delivered bytes equal
    // the render, but lines DID disappear from the repository's copy -
    // returning null here would drop the note that explains them, and the
    // tripwire (which subtracts the same relics) would stay silent too.
    const oldShape = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n${OLD_LOCAL_END}\n\n${gitignoreManagedNew}`;
    const carry = carryManagedRegion(
      gitignoreManagedNew,
      oldShape,
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      { vintage: "bounded-region", path: ".gitignore", managed_begin: HB },
    );
    expect(carry).toEqual({
      kind: "converted",
      content: gitignoreManagedNew,
      from: "bounded-region",
      extraMarkers: false,
      stripped: [OLD_LOCAL_BEGIN, OLD_GUIDANCE, OLD_LOCAL_END],
      blanksCollapsed: 1,
    });
  });

  test("a stale duplicate marker stripped to nothing still raises the extras flag", () => {
    // The tail carried ONLY a stale duplicate sentinel: the strip empties
    // the carried side, so the delivered bytes equal the render - and the
    // review hold must survive that, or a duplicate-marker copy would
    // auto-merge unexamined.
    const oldShape = `old managed\n${OLD_SENTINEL}\n${OLD_SENTINEL}\n`;
    const carry = carryManagedRegion(agentsRender, oldShape, asEntry(AGENTS_MARKERS), {
      vintage: "tail-marker",
      path: "AGENTS.md",
      marker: OLD_SENTINEL,
    });
    expect(carry).toEqual({
      kind: "converted",
      content: agentsRender,
      from: "tail-marker",
      extraMarkers: true,
      stripped: [OLD_SENTINEL],
      blanksCollapsed: 0,
    });
  });

  test("a legacy declaration falling back to the new markers strips NOTHING", () => {
    // Out-of-band conversion: HEAD's manifest still says tail-marker, the
    // FILE is already the new shape (its sentinel gone), so the legacy
    // split fails and the carry falls back to the current markers - a
    // steady-state carry. A relic-shaped line the repository owns must
    // survive that byte-identical.
    const target = `${OLD_LOCAL_BEGIN}\nrepo above\n\n${B}\nold managed\n${E}\n${OLD_GUIDANCE}\n`;
    const carry = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), {
      vintage: "tail-marker",
      path: "AGENTS.md",
      marker: OLD_SENTINEL,
    });
    expect(carry).toEqual({
      kind: "sides-restored",
      content: `${OLD_LOCAL_BEGIN}\nrepo above\n\n${agentsRender}${OLD_GUIDANCE}\n`,
    });
  });

  test("an old bounded-region copy with no relics passes through byte-identical", () => {
    // The conversion's no-op case: the target's managed half (BEGIN line to
    // EOF) already equals the render's region and its above-side carries no
    // relic line, so only the manifest shape changes and the FILE does not.
    const above = "/repo-local-cache/\n\n";
    const target = `${above}${gitignoreManagedNew}`;
    const carry = carryManagedRegion(
      gitignoreRender,
      target,
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      { vintage: "bounded-region", path: ".gitignore", managed_begin: HB },
    );
    expect(carry?.kind).toBe("converted");
    expect(carry?.content).toBe(target);
  });

  test("an unchanged managed half still converts when relics are the only diff", () => {
    const above = `${OLD_LOCAL_BEGIN}\n/repo-local-cache/\n${OLD_LOCAL_END}\n\n`;
    const target = `${above}${gitignoreManagedNew}`;
    const carry = carryManagedRegion(
      gitignoreRender,
      target,
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      { vintage: "bounded-region", path: ".gitignore", managed_begin: HB },
    );
    expect(carry?.kind).toBe("converted");
    expect(carry?.content).toBe(`/repo-local-cache/\n\n${gitignoreManagedNew}`);
  });

  test("duplicate tail markers in the previous copy: split at the FIRST, flag the extras", () => {
    const oldShape = `${OLD_SENTINEL}\nbetween the markers\n${OLD_SENTINEL}\nafter the last\n`;
    const carry = carryManagedRegion(agentsRender, oldShape, asEntry(AGENTS_MARKERS), {
      vintage: "tail-marker",
      path: "AGENTS.md",
      marker: OLD_SENTINEL,
    });
    // Everything after the FIRST marker is kept - minus the stale
    // duplicate marker itself, which is relic text, not repo content. The
    // extras flag still holds the PR for review.
    expect(carry).toEqual({
      kind: "converted",
      content: `${agentsRender}between the markers\nafter the last\n`,
      from: "tail-marker",
      extraMarkers: true,
      stripped: [OLD_SENTINEL],
      blanksCollapsed: 0,
    });
  });

  test("a HEAD declaration whose legacy shape is gone falls back to the new markers", () => {
    // The previous copy was already converted out-of-band: the legacy
    // declaration does not match, but the copy splits honestly at the new
    // markers - no appendix needed.
    const carry = carryManagedRegion(agentsRender, agentsTarget, asEntry(AGENTS_MARKERS), {
      vintage: "tail-marker",
      path: "AGENTS.md",
      marker: OLD_SENTINEL,
    });
    expect(carry).toEqual({
      kind: "sides-restored",
      content: `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
    });
  });

  test("an unsplittable previous copy is kept whole below a marked appendix", () => {
    const legacy = "# AGENTS.md\n\nold managed guidance\n\n## Project docs\n\nrepo-local notes\n";
    const carry = carryManagedRegion(agentsRender, legacy, asEntry(AGENTS_MARKERS), undefined);
    expect(carry?.kind).toBe("appendix");
    expect(carry?.content).toStartWith(agentsRender);
    expect(carry?.content).toContain("repo-platform:recovery-appendix");
    expect(carry?.content).toEndWith(legacy);
  });

  test("a blank previous copy has nothing to preserve and keeps the render", () => {
    expect(carryManagedRegion(agentsRender, "\n\n", asEntry(AGENTS_MARKERS), undefined)).toBeNull();
  });

  test("a render without a clean region throws (manifest and render disagree)", () => {
    expect(() =>
      carryManagedRegion("no markers here\n", agentsTarget, asEntry(AGENTS_MARKERS), undefined),
    ).toThrow("manifest and render disagree");
  });

  test("duplicated NEW markers in the previous copy take the appendix, never a guess", () => {
    // A second BEGIN line would make any slice a guess about which region
    // is the managed one; exactly-once or appendix.
    const target = `${B}\nfirst\n${E}\n${B}\nsecond\n${E}\n`;
    const carry = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined);
    expect(carry?.kind).toBe("appendix");
  });

  test("marker text buried mid-line counts as a duplicate (substring semantics)", () => {
    const target = `mention: ${B}\n${B}\nold\n${E}\nrepo tail\n`;
    const carry = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined);
    expect(carry?.kind).toBe("appendix");
  });

  test("an appendix neutralizes every occurrence of the entry's markers", () => {
    const target = `${B}\nold managed\nmention: ${E} mid-line\n`;
    const carry = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined);
    expect(carry?.kind).toBe("appendix");
    // The delivered file must keep exactly ONE occurrence of each marker
    // (the render's), or the validator's exactly-once rule rejects the
    // recovery output with advice pointing away from the real cause.
    expect(carry?.content.split(B).length).toBe(2);
    expect(carry?.content.split(E).length).toBe(2);
    expect(carry?.content).toContain("<!---BEGIN-REPO-PLATFORM-MANAGED--->");
  });

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

  test("a marker line with a stray trailing space still anchors the split", () => {
    // isMarkerLine trims; the stamper and the validator already counted
    // this line as the marker line... but the SUBSTRING exactly-once rule
    // still holds, so the region slices cleanly.
    const target = `${B} \nold managed\n${E}\nrepo tail\n`;
    const carry = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined);
    expect(carry).toEqual({ kind: "sides-restored", content: `${agentsRender}repo tail\n` });
  });

  test("an indented marker line anchors too (trim semantics)", () => {
    const target = `above\n  ${B}\nold\n${E}\nrepo tail\n`;
    const carry = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined);
    expect(carry).toEqual({
      kind: "sides-restored",
      content: `above\n${agentsRender}repo tail\n`,
    });
  });

  test("CRLF marker lines are recognized and the sides keep their bytes", () => {
    const render = `${B}\r\ndocs\r\n${E}\r\n`;
    const target = `${B}\r\nold\r\n${E}\r\nrepo tail\r\n`;
    expect(carryManagedRegion(render, target, asEntry(AGENTS_MARKERS), undefined)).toEqual({
      kind: "sides-restored",
      content: `${render}repo tail\r\n`,
    });
  });

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
    const gitignore = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(gitignore).toContain("/repo-local-cache/");
    expect(gitignore).toEndWith(gitignoreManagedNew);
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

  test("a recopy over a tail-marker-shaped repo converts it (HEAD manifest vintage)", () => {
    const oldShape = `# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([
        { path: "AGENTS.md", grammar: "tail-marker", marker: OLD_SENTINEL },
      ]),
      "AGENTS.md": oldShape,
    });
    initGitRepo(root);
    writeRecopy(root, [AGENTS_MARKERS], { "AGENTS.md": agentsRender });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
    );
    expect(result.summary).toContain("converted from the retired tail-marker split shape");
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
    const result = fencedResetExcerpt(["plain line"], 1000);
    expect(result).not.toBeNull();
    expect(result?.cost).toBe(Buffer.byteLength(result?.text ?? "", "utf-8"));
    expect(result?.cost ?? 0).toBeGreaterThan(Buffer.byteLength("plain line", "utf-8"));
  });

  test("a backtick-heavy line's inflated fence cannot overrun the budget", () => {
    // A 290-backtick line forces two ~291-backtick fences the old
    // accounting never charged; the true rendered size must respect the
    // budget or fall to null (the caller's count-only note).
    const lines = ["`".repeat(290), "ordinary dropped line"];
    const budget = 320; // fits the backtick line's bytes but not its fences
    const result = fencedResetExcerpt(lines, budget);
    if (result !== null) {
      expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(budget);
      expect(result.cost).toBe(Buffer.byteLength(result.text, "utf-8"));
    }
    // A comfortable budget itemizes everything, still fully charged.
    const roomy = fencedResetExcerpt(lines, 4096);
    expect(roomy).not.toBeNull();
    expect(roomy?.text).toContain("ordinary dropped line");
    expect(Buffer.byteLength(roomy?.text ?? "", "utf-8")).toBeLessThanOrEqual(4096);
    expect(roomy?.cost).toBe(Buffer.byteLength(roomy?.text ?? "", "utf-8"));
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
    const manifest = JSON.stringify({
      files: { "AGENTS.md": regionEntry({ grammar: "prefix" }) },
    });
    expect(() => splitEntries(manifest, "m")).toThrow('unknown grammar "prefix"');
  });

  test("throws on the RETIRED grammars: the post-sync manifest never carries them", () => {
    // HEAD manifests ride head_manifest.ts's transition reader; the fresh
    // render's manifest is generated by this change's own compose, so a
    // retired grammar here is damage, never a shape to convert.
    for (const grammar of ["tail-marker", "bounded-region"]) {
      const manifest = JSON.stringify({
        files: { "AGENTS.md": regionEntry({ grammar }) },
      });
      expect(() => splitEntries(manifest, "m")).toThrow("unknown grammar");
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

  test("throws on a non-comment marker (the appendix writes comments)", () => {
    const manifest = JSON.stringify({
      files: { "AGENTS.md": regionEntry({ begin: "// begin managed" }) },
    });
    expect(() => splitEntries(manifest, "m")).toThrow(
      "not a hash comment or a complete HTML comment",
    );
  });

  // The manifest text is attacker-adjacent at this boundary: it is whatever
  // the target repo's stamped file claims, so the same one-comment rule has
  // to hold here and not just at declaration time.
  test("throws on an HTML marker that is not exactly one comment", () => {
    for (const begin of ["<!-- closed --> active <!-- final -->", "<!-->"]) {
      const manifest = JSON.stringify({ files: { "AGENTS.md": regionEntry({ begin }) } });
      expect(() => splitEntries(manifest, "m")).toThrow(
        "not a hash comment or a complete HTML comment",
      );
    }
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

  test("THE TRANSITION: a tail-marker repo converts with its tail byte-identical below END", () => {
    // HEAD state: old-shape file + old-vintage manifest, exactly what
    // every fleet repo presents on the first sync after the one-grammar
    // change. The old render is old-shaped too.
    const tailBytes = Buffer.concat([
      Buffer.from("\n## Project docs\n\ncaf"),
      Buffer.from([0xe9]),
      Buffer.from(" repo-local instructions\n"),
    ]);
    const oldShapeHead = Buffer.concat([
      Buffer.from(`# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\n`),
      tailBytes,
    ]);
    const oldShapeRender = `# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\n`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([
        { path: "AGENTS.md", grammar: "tail-marker", marker: OLD_SENTINEL },
      ]),
    });
    writeFileSync(join(root, "AGENTS.md"), oldShapeHead);
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_MARKERS],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": oldShapeRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // The converted shape: fresh managed region, nothing above, the
    // previous repo tail BYTE-IDENTICAL below the END marker.
    const delivered = readFileSync(join(root, "AGENTS.md"));
    expect(delivered.equals(Buffer.concat([Buffer.from(agentsRender), tailBytes]))).toBe(true);
    expect(result.summary).toContain("converted from the retired tail-marker split shape");
    // The designed transition is verified (managed part matches the old
    // render's), so it stays auto-merge-eligible.
    expect(result.review).toBe("");
  });

  test("THE TRANSITION: an old bounded-region .gitignore converts, LOCAL area riding above", () => {
    const above = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n/repo-local-cache/\nsecret.env\n${OLD_LOCAL_END}\n\n`;
    const oldHead = `${above}${HB}\n*.old\n${HE}\n`;
    const oldRender = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n${OLD_LOCAL_END}\n\n${HB}\n*.old\n${HE}\n`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([
        { path: ".gitignore", grammar: "bounded-region", marker: HB },
      ]),
      ".gitignore": oldHead,
    });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_MARKERS],
      { ".gitignore": gitignoreRender },
      { ".gitignore": oldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // The repository's OWN patterns ride above the fresh managed region
    // byte-for-byte (the render's above-seed is NOT resurrected over
    // them); the retired markers and the now-false guidance line - all
    // platform-authored - are subtracted by the conversion, and the note
    // names each one so the PR body explains the disappearance.
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(
      `/repo-local-cache/\nsecret.env\n\n${gitignoreManagedNew}`,
    );
    expect(result.summary).toContain("converted from the retired LOCAL-region split shape");
    expect(result.summary).toContain("platform-authored relic line(s)");
    expect(result.summary).toContain(`'${OLD_GUIDANCE}'`);
    expect(result.summary).toContain(`'${OLD_LOCAL_BEGIN}'`);
    expect(result.summary).toContain(`'${OLD_LOCAL_END}'`);
    // A designed, itemized subtraction - not a review hold.
    expect(result.review).toBe("");
  });

  test("THE TRANSITION: an old bounded-region file with unchanged managed content and no relics passes through byte-identical", () => {
    const above = "/repo-local-cache/\n\n";
    const oldHead = `${above}${gitignoreManagedNew}`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([
        { path: ".gitignore", grammar: "bounded-region", marker: HB },
      ]),
      ".gitignore": oldHead,
    });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_MARKERS],
      { ".gitignore": gitignoreRender },
      { ".gitignore": oldHead },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(oldHead);
    expect(result.summary).not.toContain("platform-authored relic line(s)");
    expect(result.review).toBe("");
  });

  test("a STEADY-STATE sync of a converted .gitignore strips nothing, ever", () => {
    // The relic set is frozen historical vocabulary and the strip is the
    // conversion's alone: a repo-owned side that happens to hold a retired
    // spelling after conversion keeps it byte-identical on every later sync.
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
    expect(result.summary).not.toContain("platform-authored relic line(s)");
  });

  test("IDEMPOTENT: a second sync over a converted .gitignore rewrites nothing", () => {
    // The converted state is a fixed point of the carry: HEAD is already
    // the new shape, so the steady-state path runs and the file keeps the
    // bytes the conversion left.
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

  test("a bytes-equal strip still reaches the PR body (the all-boilerplate fleet case)", () => {
    // The most common fleet .gitignore: an all-boilerplate LOCAL block
    // above a managed half already equal to the render. The delivered
    // bytes equal the render, so nothing but the note tells the reviewer
    // the lines went - and it must be there.
    const oldHead = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n${OLD_LOCAL_END}\n\n${gitignoreManagedNew}`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([
        { path: ".gitignore", grammar: "bounded-region", marker: HB },
      ]),
      ".gitignore": oldHead,
    });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_MARKERS],
      { ".gitignore": gitignoreManagedNew },
      { ".gitignore": oldHead },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(gitignoreManagedNew);
    expect(result.summary).toContain("- `.gitignore`:");
    expect(result.summary).toContain("platform-authored relic line(s)");
    expect(result.summary).toContain(`'${OLD_GUIDANCE}'`);
    // The blank the removals left behind is counted too: the tripwire's
    // multiset ignores blanks, so the note is the only place the whole
    // difference between the previous side and the carried one is stated.
    expect(result.summary).toContain("plus 1 blank line(s) the removals left behind");
    // Loud, but not a hold: the strip is designed and itemized, so the
    // common fleet conversion stays auto-merge eligible.
    expect(result.review).toBe("");
  });

  test("the relic note is BOUNDED by the closed vocabulary, not by occurrences", () => {
    // A previous copy carrying hundreds of stale relic lines must not push
    // the carry section past the PR body's budget: the note itemizes by
    // SPELLING with a count, so it stays a handful of entries.
    const many = `${OLD_LOCAL_BEGIN}\n`.repeat(200);
    const oldHead = `${many}/repo-local-cache/\n\n${HB}\n*.old\n${HE}\n`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([
        { path: ".gitignore", grammar: "bounded-region", marker: HB },
      ]),
      ".gitignore": oldHead,
    });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_MARKERS],
      { ".gitignore": gitignoreRender },
      { ".gitignore": oldHead },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(
      `/repo-local-cache/\n\n${gitignoreManagedNew}`,
    );
    expect(result.summary).toContain("dropped 200 platform-authored relic line(s)");
    expect(result.summary).toContain(`'${OLD_LOCAL_BEGIN}' (x200)`);
    // One spelling, one entry: the note cannot grow with the file.
    expect(result.summary.split(OLD_LOCAL_BEGIN).length - 1).toBe(1);
    expect(result.summary.length).toBeLessThan(2000);
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

  test("a transition sync still resets and itemizes managed-half edits", () => {
    // The conversion must not launder local edits inside the OLD managed
    // half: HEAD's managed part (per ITS declaration) differs from the old
    // render's, so the reset is loud and itemized even while the shape
    // converts.
    const oldShapeRender = `old security prefix\n${OLD_SENTINEL}\n`;
    const oldShapeHead = `old security prefix EDITED\n${OLD_SENTINEL}\n\nrepo tail\n`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([
        { path: "SECURITY.md", grammar: "tail-marker", marker: OLD_SENTINEL },
      ]),
      "SECURITY.md": oldShapeHead,
    });
    initGitRepo(root);
    writeFileSync(join(root, "SECURITY.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [SECURITY_MARKERS],
      { "SECURITY.md": securityNew },
      { "SECURITY.md": oldShapeRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "SECURITY.md"), "utf-8")).toBe(`${securityNew}\nrepo tail\n`);
    expect(result.summary).toContain("converted from the retired tail-marker split shape");
    expect(result.summary).toContain("RESET to the fresh render");
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
    const rebuilt = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(rebuilt).toEndWith(gitignoreManagedNew);
    expect(rebuilt).not.toContain("hand-added-in-managed/");
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

  test("duplicate retired markers in the previous copy flag review on conversion", () => {
    const oldShape = `old managed\n${OLD_SENTINEL}\ntail\n${OLD_SENTINEL}\nstale duplicate\n`;
    const root = makeTarget({
      [MANIFEST_REL]: legacyManifestJson([
        { path: "AGENTS.md", grammar: "tail-marker", marker: OLD_SENTINEL },
      ]),
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
    expect(result.review).toContain("AGENTS.md: duplicate split markers");
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
    expect(result.review).toContain("AGENTS.md: managed region unverifiable");
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

  test("an unreadable HEAD manifest degrades to the appendix, never a guessed conversion", () => {
    // The HEAD manifest is damaged; the old-shape file cannot split at the
    // new markers, and no legacy declaration is trusted from damage - the
    // whole previous copy is preserved below the appendix, review forced.
    const oldShape = `old managed\n${OLD_SENTINEL}\nrepo tail\n`;
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
    const rebuilt = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(rebuilt).toStartWith(agentsRender);
    expect(rebuilt).toContain("repo-platform:recovery-appendix");
    expect(rebuilt).toEndWith(oldShape);
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
        ["copier", "recopy", "--overwrite", "--vcs-ref", "HEAD", ...copierArgs],
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
