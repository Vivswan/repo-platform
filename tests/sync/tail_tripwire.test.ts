// tail_tripwire.ts: the post-stamp defense-in-depth check that no split
// file's repository-owned content lost non-blank lines it held at the
// target's HEAD - each side split by its OWN manifest declaration (one
// grammar: managed-region) - plus the loud refusal of pre-grammar,
// retired-grammar, and unknown-grammar HEAD manifests. The script-level
// tests build a real git repo whose HEAD carries both the previous file
// copies and the previous manifest, then overwrite the working tree with
// the "delivered" state - exactly the shape the sync leg hands the
// tripwire.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
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
import type { SplitEntry } from "../../.github/scripts/sync/preserve_local_content.ts";
import {
  compareHalves,
  headSplitEntries,
  missingLines,
  renderReport,
} from "../../.github/scripts/sync/tail_tripwire.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/tail_tripwire.ts");

const MANIFEST_NAME = ".github/repo-platform-manifest.json";
const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
const E = "<!-- END REPO-PLATFORM MANAGED -->";
const HB = "# BEGIN REPO-PLATFORM MANAGED";
const HE = "# END REPO-PLATFORM MANAGED";
const OLD_SENTINEL = "<!-- repo-platform:local-section -->";
const OLD_LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
const OLD_LOCAL_END = "# END REPOSITORY LOCAL";

const agentsHead = `${B}\n# AGENTS.md\n\nold managed guidance\n${E}\n\n## Project docs\n\nrepo-local instructions\n`;
const agentsDelivered = `${B}\n# AGENTS.md\n\nfresh managed guidance\n${E}\n\n## Project docs\n\nrepo-local instructions\n`;

/** A .gitignore-shaped file in the CURRENT grammar: repo-owned content
 * above, then the managed region. */
function regionFile(aboveLines: string[], managedLines: string[]): string {
  return `${aboveLines.map((l) => `${l}\n`).join("")}${HB}\n${managedLines.map((l) => `${l}\n`).join("")}${HE}\n`;
}

/** SplitEntry builders (the parsed shape splitEntries produces). */
function regionSplit(path = "AGENTS.md", begin: string = B, end: string = E): SplitEntry {
  return { path, grammar: "managed-region", begin, end };
}

/** HeadSplit builders (head_manifest.ts's parsed shape). */
const headRegion = (path = "AGENTS.md", begin: string = B, end: string = E) =>
  ({ path, begin, end }) as const;

/** Manifest JSON builders (the raw shape the manifest files carry). */
type RawEntry = Record<string, unknown>;
function manifestText(files: Record<string, RawEntry>): string {
  return `${JSON.stringify({ files }, null, 2)}\n`;
}
const rawRegion = (begin: string = B, end: string = E): RawEntry => ({
  class: "split",
  grammar: "managed-region",
  begin,
  end,
});
/** The RETIRED vintages' wire shapes, exactly as the old compose emitted
 * them. The sync no longer reads them (the one-time conversion machinery
 * is deleted) - these builders exist to prove the loud refusal. */
const rawLegacyTail = (marker: string = OLD_SENTINEL): RawEntry => ({
  class: "split",
  grammar: "tail-marker",
  marker,
  managed: "above",
});
const rawLegacyBounded = (): RawEntry => ({
  class: "split",
  grammar: "bounded-region",
  marker: HB,
  managed: "below",
  managed_end: HE,
  local_begin: OLD_LOCAL_BEGIN,
  local_end: OLD_LOCAL_END,
});
/** The retired pre-grammar wire shape: split entries stamped before the
 * grammar field existed carried only a marker/managed pair. The sync no
 * longer reads it - these builders exist to prove the refusal. */
const rawPreGrammar = (marker: string, managed: "above" | "below"): RawEntry => ({
  class: "split",
  marker,
  managed,
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
  run("commit", "-qm", "pre-sync state");
}

/** A target repo whose HEAD holds `headFiles` and whose working tree was
 * then overwritten with `delivered` (the post-sync state). */
function makeTarget(
  headFiles: Record<string, string | Buffer>,
  delivered: Record<string, string | Buffer>,
): string {
  const base = mkdtempSync(join(tmpdir(), "tail-tripwire-"));
  const root = join(base, "target");
  mkdirSync(root);
  for (const [rel, content] of Object.entries(headFiles)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  initGitRepo(root);
  for (const rel of Object.keys(headFiles)) {
    if (!(rel in delivered)) rmSync(join(root, rel));
  }
  for (const [rel, content] of Object.entries(delivered)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function runScript(
  root: string,
  extraArgs: string[] = [],
): { exitCode: number; stdout: string; stderr: string; report: string } {
  const reportPath = join(root, "..", "tail-shrank.md");
  const proc = boundedSpawnSync(
    ["bun", script, "--report", reportPath, "--root", root, ...extraArgs],
    { env: gitFreeEnv() },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    report: existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "",
  };
}

describe("headSplitEntries (re-exported for the sync legs)", () => {
  test("reads every managed-region entry, each with its own marker dialect", () => {
    // head_manifest.test.ts pins one split entry beside a non-split one;
    // this pins that several splits accumulate, keyed by path, markers
    // per entry - the sync legs look entries up by `map.get(path)`.
    const map = headSplitEntries(
      manifestText({ "AGENTS.md": rawRegion(), ".gitignore": rawRegion(HB, HE) }),
      "t",
    );
    expect(map).toEqual(
      new Map([
        ["AGENTS.md", { path: "AGENTS.md", begin: B, end: E }],
        [".gitignore", { path: ".gitignore", begin: HB, end: HE }],
      ]),
    );
  });

  // head_manifest.test.ts pins the plain refusals (unknown grammar -
  // registry-proven there - unknown class, non-JSON, files: [],
  // entry-level duplicate keys, non-ASCII markers). These rows are the
  // shapes it does not: the retired and pre-grammar vintages with the
  // ADVICE ORDER pinned (the recovery advice precedes the target-controlled
  // values, so it always survives the PR-body clip), and the damage shapes
  // whose silent acceptance would skip a real file's check or reclassify
  // it - every one must throw so the sync legs fail closed (unverifiable,
  // manual review) instead of guessing a split.
  const managedEntry = '{"class": "managed", "hash": null}';
  // The second spelling escapes the final "d" as backslash-u0064: a
  // byte-level raw-token compare would miss it, but JSON.parse still
  // collides the two keys last-wins.
  const escapedKey = String.raw`"AGENTS.m\u0064"`;
  test.each([
    {
      reason: "a pre-grammar entry: the diagnosis, then the advice",
      text: manifestText({ "AGENTS.md": rawPreGrammar(OLD_SENTINEL, "above") }),
      error: /predates the stamped split grammar.*recover=recopy/,
    },
    {
      reason: "a mixed manifest (grammar beside a pre-grammar entry) is refused the same way",
      text: manifestText({
        "AGENTS.md": rawRegion(),
        "SECURITY.md": rawPreGrammar(OLD_SENTINEL, "above"),
      }),
      error: /predates the stamped split grammar/,
    },
    {
      reason: "the RETIRED tail-marker vintage: advice before the target-controlled grammar",
      text: manifestText({ "AGENTS.md": rawLegacyTail() }),
      error: /recover=recopy.*split grammar "tail-marker"/,
    },
    {
      reason: "the RETIRED bounded-region vintage: advice before the target-controlled grammar",
      text: manifestText({ ".gitignore": rawLegacyBounded() }),
      error: /recover=recopy.*split grammar "bounded-region"/,
    },
    {
      reason: "an unclean split path ('../AGENTS.md') could never match the post-sync key",
      text: manifestText({ "../AGENTS.md": rawRegion() }),
      error: /clean relative path/,
    },
    {
      reason: "a duplicated path key (split, then managed) must not last-wins reclassify the file",
      text: `{"files": {"AGENTS.md": ${JSON.stringify(rawRegion())}, "AGENTS.md": ${managedEntry}}}`,
      error: /same key twice/,
    },
    {
      reason: "an escape-variant duplicate key collides after decoding and is caught too",
      text: `{"files": {"AGENTS.md": ${JSON.stringify(rawRegion())}, ${escapedKey}: ${managedEntry}}}`,
      error: /same key twice/,
    },
    {
      reason: "a MISSING ownership class must not read as non-split",
      text: manifestText({ "AGENTS.md": { begin: B } }),
      error: /ownership class/,
    },
    {
      reason: "a null entry must not silently skip its file",
      text: manifestText({ "AGENTS.md": null as never }),
      error: /not an object/,
    },
    {
      reason: "an array entry passes typeof object and must fail the same way",
      text: manifestText({ "AGENTS.md": [] as never }),
      error: /not an object/,
    },
    {
      reason:
        "an EMPTY marker would select the synthetic empty line at EOF (every local line lost, wire clear)",
      text: manifestText({ "AGENTS.md": rawRegion("", E) }),
      error: /printable-ASCII/,
    },
  ])("refuses: $reason", ({ text, error }) => {
    expect(() => headSplitEntries(text, "t")).toThrow(error);
  });
});

describe("missingLines", () => {
  const latin1Line = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("latin1"); // caf\xe9
  const utf8Line = Buffer.from("café", "utf-8").toString("latin1"); // caf\xc3\xa9
  // Previous repo-owned text vs delivered: the non-blank previous lines
  // with no delivered occurrence left to consume - order-free (a moved
  // line is not a lost one), a multiset (a plain Set would pass exactly
  // the shrink this wire exists to catch), byte-exact (split-file repo
  // sides are carried byte-for-byte, so a line-ending flip IS a byte
  // change worth a manual look - warn-cheap by design).
  test.each([
    {
      reason: "every non-blank line survives, wherever it moved",
      previous: "one\ntwo\n",
      delivered: "two\nextra\none\n",
      missing: [],
    },
    {
      reason: "each vanished non-blank line is named",
      previous: "one\ntwo\nthree\n",
      delivered: "one\n",
      missing: ["two", "three"],
    },
    {
      reason: "blank and whitespace-only lines never count as lost",
      previous: "one\n\n   \n\t\n",
      delivered: "one\n",
      missing: [],
    },
    {
      reason: "multiset: a line held twice and delivered once is missing",
      previous: "dup\nother\ndup\n",
      delivered: "dup\nother\n",
      missing: ["dup"],
    },
    {
      reason: "multiset: a surplus delivered copy is never a loss",
      previous: "dup\ndup\n",
      delivered: "dup\ndup\nextra\n",
      missing: [],
    },
    {
      reason: "byte-exact: a latin1 byte and its utf-8 spelling are different lines",
      previous: `${latin1Line}\n`,
      delivered: `${utf8Line}\n`,
      missing: [latin1Line],
    },
    {
      reason: "byte-exact: the same latin1 bytes on both sides survive",
      previous: `${latin1Line}\n`,
      delivered: `${latin1Line}\n`,
      missing: [],
    },
    {
      reason: "byte-exact: CRLF and LF spellings of a line are different lines",
      previous: "one\r\ntwo\r\n",
      delivered: "one\ntwo\n",
      missing: ["one\r", "two\r"],
    },
    {
      reason: "byte-exact: CRLF on both sides survives",
      previous: "one\r\ntwo\r\n",
      delivered: "one\r\ntwo\r\n",
      missing: [],
    },
  ])("$reason", ({ previous, delivered, missing }) => {
    expect(missingLines(previous, delivered)).toEqual(missing);
  });
});

describe("compareHalves", () => {
  test("null when the delivered repo-owned content keeps every line", () => {
    expect(compareHalves(regionSplit(), headRegion(), agentsHead, agentsDelivered)).toBeNull();
  });

  test("shrank when a line vanished", () => {
    const delivered = `${B}\nfresh managed guidance\n${E}\n\n## Project docs\n`;
    expect(compareHalves(regionSplit(), headRegion(), agentsHead, delivered)).toEqual({
      path: "AGENTS.md",
      kind: "shrank",
      missing: ["repo-local instructions"],
    });
  });

  test("each side splits with its OWN markers (marker-rename safety)", () => {
    const oldB = "<!-- OLD BEGIN -->";
    const oldE = "<!-- OLD END -->";
    const head = `${oldB}\nold managed\n${oldE}\nrepo tail\n`;
    const delivered = `${B}\nnew managed\n${E}\nrepo tail\n`;
    expect(
      compareHalves(regionSplit(), headRegion("AGENTS.md", oldB, oldE), head, delivered),
    ).toBeNull();
    // Splitting HEAD with the NEW markers instead would be the mis-split
    // this design rules out: the old copy has no such lines.
    expect(compareHalves(regionSplit(), headRegion(), head, delivered)?.kind).toBe("unverifiable");
  });

  test("nothing is ever subtracted: a relic-shaped line the repo owns is guarded", () => {
    // The conversion-era relic strip is deleted: a retired spelling in
    // repo-owned space is the repository's content, and losing it fires
    // like any other repo-owned line.
    const head = `${OLD_LOCAL_BEGIN}\n/repo-local-cache/\n\n${HB}\n*.old\n${HE}\n`;
    const delivered = `/repo-local-cache/\n\n${HB}\n*.new\n${HE}\n`;
    expect(
      compareHalves(
        regionSplit(".gitignore", HB, HE),
        headRegion(".gitignore", HB, HE),
        head,
        delivered,
      ),
    ).toEqual({ path: ".gitignore", kind: "shrank", missing: [OLD_LOCAL_BEGIN] });
  });

  test("region content compares across BOTH sides as one multiset", () => {
    const head = regionFile(["local-one", "local-two"], ["*.old"]);
    // local-two moved BELOW the region: still not a loss.
    const kept = `local-one\n${HB}\n*.new\n${HE}\nlocal-two\n`;
    expect(
      compareHalves(
        regionSplit(".gitignore", HB, HE),
        headRegion(".gitignore", HB, HE),
        head,
        kept,
      ),
    ).toBeNull();
    const shrank = regionFile(["local-one"], ["*.new"]);
    expect(
      compareHalves(
        regionSplit(".gitignore", HB, HE),
        headRegion(".gitignore", HB, HE),
        head,
        shrank,
      ),
    ).toEqual({
      path: ".gitignore",
      kind: "shrank",
      missing: ["local-two"],
    });
  });

  test("a HEAD copy that does not split by its own declaration is unverifiable", () => {
    expect(compareHalves(regionSplit(), headRegion(), "no marker here\n", agentsDelivered)).toEqual(
      {
        path: "AGENTS.md",
        kind: "unverifiable",
        reason:
          "the previous commit's copy does not split at its own manifest's declared marker " +
          "lines, so its repository-owned content cannot be located",
      },
    );
  });

  test("a delivered copy that does not split by the post-sync manifest is unverifiable", () => {
    expect(
      compareHalves(regionSplit(), headRegion(), agentsHead, "render lost its markers\n"),
    ).toEqual({
      path: "AGENTS.md",
      kind: "unverifiable",
      reason:
        "the delivered copy does not split at the post-sync manifest's declared marker " +
        "lines, so its repository-owned content cannot be located",
    });
  });
});

describe("renderReport", () => {
  test("empty for no findings", () => {
    expect(renderReport([])).toBe("");
  });

  test("bounds a long missing-lines excerpt", () => {
    const missing = Array.from({ length: 45 }, (_, i) => `line ${i}`);
    const report = renderReport([{ path: "AGENTS.md", kind: "shrank", missing }]);
    expect(report).toContain("45 non-blank line(s)");
    expect(report).toContain("line 39");
    expect(report).not.toContain("line 40");
    expect(report).toContain("(5 more; see the previous commit's copy)");
  });

  test("one enormous missing line cannot blow the PR-body budget", () => {
    // gh fails outright past GitHub's 64 KiB body cap, which would strand
    // the pushed branch with no PR - the exact failure the warn-not-red
    // contract exists to avoid.
    const report = renderReport([
      { path: "AGENTS.md", kind: "shrank", missing: ["x".repeat(70000)] },
    ]);
    expect(Buffer.byteLength(report, "utf-8")).toBeLessThan(20000);
    expect(report).toContain("[clipped]");
  });

  test("an enormous unverifiable reason is bounded too", () => {
    const report = renderReport([
      { path: "AGENTS.md", kind: "unverifiable", reason: `marker ${"y".repeat(70000)} missing` },
    ]);
    expect(Buffer.byteLength(report, "utf-8")).toBeLessThan(20000);
    expect(report).toContain("[clipped]");
  });

  test("a missing line made of backticks cannot close the excerpt fence", () => {
    const report = renderReport([
      { path: "AGENTS.md", kind: "shrank", missing: ["`````", "after the backticks"] },
    ]);
    // The fence outruns the longest backtick run in the content, so the
    // second line stays inside the block.
    expect(report).toMatch(/``````text\n/);
    expect(report).toContain("  after the backticks");
  });

  test("the total excerpt budget spans files; past it, count-only bullets", () => {
    const missing = Array.from({ length: 40 }, (_, i) => `${"y".repeat(290)}-${i}`);
    const findings = Array.from({ length: 4 }, (_, i) => ({
      path: `FILE${i}.md`,
      kind: "shrank" as const,
      missing,
    }));
    const report = renderReport(findings);
    expect(Buffer.byteLength(report, "utf-8")).toBeLessThan(24000);
    // Every finding still gets its bullet, even once the excerpt budget
    // is spent.
    for (const { path } of findings) expect(report).toContain(`\`${path}\``);
    expect(report).toContain("excerpt omitted: report size limit");
  });
});

describe("tail_tripwire script", () => {
  const headManifest = manifestText({ "AGENTS.md": rawRegion() });

  // The two clear shapes share one assertion set: no report, the clear
  // line, no warning. Blank-line skipping itself is unit-pinned in the
  // missingLines rows; this row proves the script's wiring honours it.
  test.each([
    {
      reason: "the repository-owned content survives a managed change",
      head: agentsHead,
      delivered: agentsDelivered,
    },
    {
      reason: "blank lines dropped from the previous tail never fire",
      head: `${B}\nold\n${E}\n\nkeep me\n   \n\n`,
      delivered: `${B}\nnew\n${E}\nkeep me\n`,
    },
  ])("clear: $reason", ({ head, delivered }) => {
    const root = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
    expect(result.stdout).toContain("tail tripwire clear");
    expect(result.stdout).not.toContain("::warning::");
  });

  // Warn, not red: a blocked delivery would hide the diff the reviewer
  // needs, so the wire warns, writes the report (which forces the PR
  // manual), and exits 0. The multiset semantics are unit-pinned in the
  // missingLines rows; the second row proves the script's wiring keeps
  // them (a Set-based check would call the shrink clean and leave it
  // auto-merge eligible).
  test.each([
    {
      reason: "a vanished tail line",
      head: agentsHead,
      delivered: `${B}\n# AGENTS.md\n\nfresh managed guidance\n${E}\n\n## Project docs\n`,
      missingLine: "repo-local instructions",
    },
    {
      reason: "a duplicated tail line shrinking to one copy",
      head: `${B}\nmanaged\n${E}\n\ndup entry\ndup entry\n`,
      delivered: `${B}\nmanaged\n${E}\n\ndup entry\n`,
      missingLine: "dup entry",
    },
  ])("fires on $reason: warns, reports, exits 0", ({ head, delivered, missingLine }) => {
    const root = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("AGENTS.md: 1 repository-owned line(s) missing");
    expect(result.report).toContain("> [!WARNING]");
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain(missingLine);
  });

  // The retired conversion and the retired legacy fallback used to serve
  // exactly these HEAD states silently; a straggler manifest now trips the
  // wire on every split file - warn, manual review, the report naming the
  // refusal and the fix - with NO loss claim fabricated: the delivered
  // copies keep every previous line. The refusal messages themselves are
  // unit-pinned (head_manifest.test.ts and the headSplitEntries rows
  // above); these rows prove the script routes them into the findings.
  // Warn, not red: going red would block the very sync whose recovery
  // follow-up heals the manifest.
  test.each([
    {
      vintage: "RETIRED-vintage (tail-marker/bounded-region)",
      straggler: manifestText({ "AGENTS.md": rawLegacyTail(), ".gitignore": rawLegacyBounded() }),
      phrase: 'split grammar "tail-marker"',
    },
    {
      vintage: "pre-grammar",
      straggler: manifestText({
        "AGENTS.md": rawPreGrammar(OLD_SENTINEL, "above"),
        ".gitignore": rawPreGrammar(HB, "below"),
      }),
      phrase: "predates the stamped split grammar",
    },
  ])(
    "a $vintage HEAD manifest fails loudly: unverifiable findings with the recovery advice",
    ({ straggler, phrase }) => {
      const newManifest = manifestText({
        "AGENTS.md": rawRegion(),
        ".gitignore": rawRegion(HB, HE),
      });
      const agentsOldShape = `# AGENTS.md\n\nold managed\n\n${OLD_SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`;
      const gitignoreOldShape = `${OLD_LOCAL_BEGIN}\n/repo-local-cache/\n${OLD_LOCAL_END}\n\n${HB}\n*.old\n${HE}\n`;
      const agentsDeliveredFull = `${B}\n# AGENTS.md\n\nold managed\n${E}\n\n${OLD_SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`;
      const root = makeTarget(
        {
          "AGENTS.md": agentsOldShape,
          ".gitignore": gitignoreOldShape,
          [MANIFEST_NAME]: straggler,
        },
        {
          "AGENTS.md": agentsDeliveredFull,
          ".gitignore": gitignoreOldShape,
          [MANIFEST_NAME]: newManifest,
        },
      );
      const result = runScript(root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("::warning::");
      expect(result.report).toContain("`AGENTS.md`");
      expect(result.report).toContain("`.gitignore`");
      expect(result.report).toContain(phrase);
      expect(result.report).toContain("recover=recopy");
      expect(result.report).not.toContain("missing from this update's copy");
    },
  );

  // A HEAD without a usable manifest - absent, or one the reader refuses -
  // makes every previously-present split file unverifiable (manual
  // review), never red and never a guessed split: the refusal's message
  // rides into the finding so the PR body names the fix. A symlinked
  // manifest is the same outcome; its fixture lives in its own test below.
  const unusableHeadManifests: { reason: string; head: Record<string, string>; extra?: string }[] =
    [
      { reason: "that is absent", head: {} },
      {
        reason: "that is unparseable (treated like a missing one)",
        head: { [MANIFEST_NAME]: "{ not json" },
      },
      {
        reason: "of an unknown grammar (never guessed)",
        head: {
          [MANIFEST_NAME]: manifestText({
            "AGENTS.md": { class: "split", grammar: "mystery", marker: OLD_SENTINEL },
          }),
        },
        extra: 'split grammar "mystery"',
      },
      {
        reason: "carrying a damaged (null) entry (never silently skipped)",
        head: { [MANIFEST_NAME]: manifestText({ "AGENTS.md": null as never }) },
      },
    ];
  test.each(unusableHeadManifests)(
    "a HEAD manifest $reason makes its split files unverifiable, not red",
    ({ head, extra }) => {
      const root = makeTarget(
        { "AGENTS.md": agentsHead, ...head },
        { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: headManifest },
      );
      const result = runScript(root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("::warning::");
      expect(result.report).toContain("no usable ownership manifest");
      if (extra !== undefined) expect(result.report).toContain(extra);
      // Unverifiable, not a loss claim: no fabricated shrank heading.
      expect(result.report).not.toContain("missing from this update's copy");
    },
  );

  test("a NUL-carrying tail line reaches the report escaped, never as a raw control byte", () => {
    // latin1 preserves a NUL byte end to end; raw in the report it would
    // ride into open_pr's --body argv, and OS argv cannot carry NUL - the
    // warn-only wire would become the thing that BLOCKS PR creation.
    const nulLine = "secret\x00control\x01line";
    const head = `${B}\nmanaged\n${E}\n\n${nulLine}\n`;
    const delivered = `${B}\nmanaged\n${E}\n`;
    const root = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("secret\\x00control\\x01line");
    expect(result.report).not.toContain("\x00");
    expect(result.report).not.toContain("\x01");
    // End to end: the report must be spawnable as an argv element, the
    // way open_pr passes the assembled body to gh.
    const spawn = boundedSpawnSync(["true", result.report]);
    expect(spawn.exitCode).toBe(0);
  });

  test("a marker rename cannot mis-split HEAD's copy (HEAD manifest wins there)", () => {
    const oldB = "<!-- OLD BEGIN -->";
    const oldE = "<!-- OLD END -->";
    const head = `${oldB}\nold managed\n${oldE}\nrepo tail line\n`;
    const delivered = `${B}\nnew managed\n${E}\nrepo tail line\n`;
    const root = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: manifestText({ "AGENTS.md": rawRegion(oldB, oldE) }) },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("non-UTF-8 tail bytes compare byte-for-byte and never false-fire", () => {
    const tailBytes = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9])]);
    const head = Buffer.concat([Buffer.from(`${B}\nold\n${E}\n`), tailBytes, Buffer.from("\n")]);
    const delivered = Buffer.concat([
      Buffer.from(`${B}\nnew\n${E}\n`),
      tailBytes,
      Buffer.from("\n"),
    ]);
    const root = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: headManifest },
    );
    expect(runScript(root).report).toBe("");
    // And when the byte-carrying line IS dropped, the report keeps it
    // lossless: the latin1 code unit lands in the utf-8 report as U+00E9,
    // never U+FFFD.
    const shrankRoot = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": `${B}\nnew\n${E}\n`, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(shrankRoot);
    expect(result.report).toContain("café");
    expect(result.report).not.toContain("�");
  });

  test("a path absent at HEAD is skipped (nothing to lose)", () => {
    const root = makeTarget(
      { "README.md": "readme\n", [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: headManifest, "README.md": "readme\n" },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("a path HEAD's own manifest did not class as split is skipped", () => {
    // Ownership flips have their own review machinery; HEAD claimed no
    // repository-owned content here, so there is nothing this wire guards.
    const root = makeTarget(
      {
        "AGENTS.md": "wholly managed before, no markers\n",
        [MANIFEST_NAME]: manifestText({ "AGENTS.md": { class: "managed" } }),
      },
      { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("a symlink at HEAD at a split path is unverifiable, never parsed as content", () => {
    // `git show HEAD:AGENTS.md` answers the TARGET PATH STRING for a
    // symlink (a real managed-repo shape: CLAUDE.md and friends are links
    // to AGENTS.md by design); the old bytes probe handed that string to
    // the marker parser as if it were the previous copy.
    const base = mkdtempSync(join(tmpdir(), "tail-tripwire-"));
    const root = join(base, "target");
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, MANIFEST_NAME), headManifest);
    writeFileSync(join(root, "REAL.md"), agentsHead);
    symlinkSync("REAL.md", join(root, "AGENTS.md"));
    initGitRepo(root);
    unlinkSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, "AGENTS.md"), agentsDelivered);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.report).toContain("carries a symlink at this path, not a regular file");
    // Unverifiable, not a loss claim: no shrank heading, no fabricated excerpt.
    expect(result.report).not.toContain("missing from this update's copy");
  });

  test("a directory at HEAD at a split path is unverifiable, never read as tree-listing prose", () => {
    // `git show HEAD:AGENTS.md` answers "tree HEAD:AGENTS.md" plus entry
    // names for a directory; that prose must never stand in for the
    // previous copy.
    const base = mkdtempSync(join(tmpdir(), "tail-tripwire-"));
    const root = join(base, "target");
    mkdirSync(join(root, ".github"), { recursive: true });
    mkdirSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, MANIFEST_NAME), headManifest);
    writeFileSync(join(root, "AGENTS.md", "inner.md"), agentsHead);
    initGitRepo(root);
    rmSync(join(root, "AGENTS.md"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), agentsDelivered);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.report).toContain("carries a directory at this path, not a regular file");
    expect(result.report).not.toContain("missing from this update's copy");
  });

  test("a symlinked HEAD manifest is as unusable as a damaged one", () => {
    // The manifest path itself as a link: `git show` would answer the
    // link target, not manifest JSON - only a blob is ever parsed.
    const base = mkdtempSync(join(tmpdir(), "tail-tripwire-"));
    const root = join(base, "target");
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github", "manifest-real.json"), headManifest);
    symlinkSync("manifest-real.json", join(root, MANIFEST_NAME));
    writeFileSync(join(root, "AGENTS.md"), agentsHead);
    initGitRepo(root);
    unlinkSync(join(root, MANIFEST_NAME));
    writeFileSync(join(root, MANIFEST_NAME), headManifest);
    writeFileSync(join(root, "AGENTS.md"), agentsDelivered);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("no usable ownership manifest");
  });

  test("an unknown grammar in the POST-SYNC manifest is a broken input and goes red", () => {
    // Our own render produced this manifest; refusing to guess matches
    // preserve_local_content's discipline.
    const mystery = manifestText({
      "AGENTS.md": { class: "split", grammar: "mystery", begin: B, end: E },
    });
    const root = makeTarget(
      { "AGENTS.md": agentsHead, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: mystery },
    );
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refuses to guess");
  });

  test("a delivered copy missing from the working tree is unverifiable", () => {
    const root = makeTarget(
      { "AGENTS.md": agentsHead, [MANIFEST_NAME]: headManifest },
      { [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("no such file");
  });

  test("--hide-details prints the count warning but no paths", () => {
    const delivered = `${B}\n# AGENTS.md\n\nfresh managed guidance\n${E}\n`;
    const root = makeTarget(
      { "AGENTS.md": agentsHead, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root, ["--hide-details", "true"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("paths hidden: private repository");
    expect(result.stdout).not.toContain("AGENTS.md");
    expect(result.report).toContain("`AGENTS.md`");
  });

  test("a missing post-sync manifest is a broken input and goes red", () => {
    // Delivered state carries neither the manifest nor the split file:
    // makeTarget cleared the working tree of everything not delivered.
    const root = makeTarget({ "AGENTS.md": agentsHead, [MANIFEST_NAME]: headManifest }, {});
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("must carry the ownership manifest");
  });
});
