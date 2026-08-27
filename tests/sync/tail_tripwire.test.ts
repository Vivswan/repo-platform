// tail_tripwire.ts: the post-stamp defense-in-depth check that no split
// file's repository-owned half lost non-blank lines it held at the
// target's HEAD, across both split grammars (tail-marker, bounded-region)
// and legacy pre-grammar HEAD manifests. The script-level tests build a
// real git repo whose HEAD carries both the previous file copies and the
// previous manifest, then overwrite the working tree with the "delivered"
// state - exactly the shape the sync leg hands the tripwire.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SplitEntry } from "../../.github/scripts/sync/preserve_local_content.ts";
import {
  compareHalves,
  headSplitEntries,
  missingLines,
  renderReport,
  repoOwnedHalf,
} from "../../.github/scripts/sync/tail_tripwire.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/tail_tripwire.ts");

const SENTINEL = "<!-- repo-platform:local-section -->";
const MANIFEST_NAME = ".github/repo-platform-manifest.json";
const LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
const LOCAL_END = "# END REPOSITORY LOCAL";
const MANAGED_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const MANAGED_END = "# END REPO-PLATFORM MANAGED";

const agentsHead = `# AGENTS.md\n\nold managed guidance\n\n${SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`;
const agentsDelivered = `# AGENTS.md\n\nfresh managed guidance\n\n${SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`;

/** A .gitignore-shaped file: local region, then the managed section. */
function regionFile(bodyLines: string[], managedLines: string[]): string {
  return `${LOCAL_BEGIN}\n${bodyLines.map((l) => `${l}\n`).join("")}${LOCAL_END}\n\n${MANAGED_BEGIN}\n${managedLines.map((l) => `${l}\n`).join("")}${MANAGED_END}\n`;
}

/** SplitEntry builders (the parsed shape splitEntries produces). */
function tailEntry(path = "AGENTS.md", marker: string = SENTINEL): SplitEntry {
  return { path, grammar: "tail-marker", marker };
}
function regionEntry(
  path = ".gitignore",
  markers: { begin: string; end: string; managedBegin: string; managedEnd: string } = {
    begin: LOCAL_BEGIN,
    end: LOCAL_END,
    managedBegin: MANAGED_BEGIN,
    managedEnd: MANAGED_END,
  },
): SplitEntry {
  return {
    path,
    grammar: "bounded-region",
    marker: markers.managedBegin,
    begin: markers.begin,
    end: markers.end,
    all: [markers.begin, markers.end, markers.managedBegin, markers.managedEnd],
  };
}
const asHead = (entry: SplitEntry) => ({ kind: "grammar", entry }) as const;

/** Manifest JSON builders (the raw shape the manifest files carry). */
type RawEntry = Record<string, unknown>;
function manifestText(files: Record<string, RawEntry>): string {
  return `${JSON.stringify({ files }, null, 2)}\n`;
}
const rawTail = (marker: string = SENTINEL): RawEntry => ({
  class: "split",
  grammar: "tail-marker",
  marker,
  managed: "above",
});
const rawRegion = (): RawEntry => ({
  class: "split",
  grammar: "bounded-region",
  marker: MANAGED_BEGIN,
  managed: "below",
  managed_end: MANAGED_END,
  local_begin: LOCAL_BEGIN,
  local_end: LOCAL_END,
});
const rawLegacy = (marker: string, managed: "above" | "below"): RawEntry => ({
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
    const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: gitFreeEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
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
): { exitCode: number | null; stdout: string; stderr: string; report: string } {
  const reportPath = join(root, "..", "tail-shrank.md");
  const proc = Bun.spawnSync(
    ["bun", script, "--report", reportPath, "--root", root, ...extraArgs],
    { env: gitFreeEnv(), stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    report: existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "",
  };
}

describe("repoOwnedHalf", () => {
  test("tail-marker: the half below the marker line", () => {
    expect(repoOwnedHalf(`managed\n${SENTINEL}\ntail\n`, tailEntry())).toBe("tail\n");
  });

  test("tail-marker: managed and repo-owned halves partition the content exactly", () => {
    const content = `a\n${SENTINEL}\nb\n`;
    expect(repoOwnedHalf(content, tailEntry())).toBe("b\n");
    expect(`a\n${SENTINEL}\n${repoOwnedHalf(content, tailEntry())}`).toBe(content);
  });

  test("tail-marker: missing marker line means no honest split", () => {
    expect(repoOwnedHalf("no marker here\n", tailEntry())).toBeNull();
  });

  test("bounded-region: the local region body, not everything above the managed marker", () => {
    const content = regionFile(["keep-me"], ["*.new"]);
    expect(repoOwnedHalf(content, regionEntry())).toBe("keep-me\n");
  });

  test("bounded-region: a duplicated region marker is unlocatable, never guessed", () => {
    const content = `${LOCAL_BEGIN}\nbody\n${LOCAL_END}\n${LOCAL_BEGIN}\n${LOCAL_END}\n${MANAGED_BEGIN}\n${MANAGED_END}\n`;
    expect(repoOwnedHalf(content, regionEntry())).toBeNull();
  });
});

describe("headSplitEntries", () => {
  test("parses a grammar-bearing manifest strictly", () => {
    const map = headSplitEntries(
      manifestText({ "AGENTS.md": rawTail(), ".gitignore": rawRegion() }),
      "t",
    );
    expect(map.get("AGENTS.md")).toEqual({ kind: "grammar", entry: tailEntry() });
    expect(map.get(".gitignore")?.kind).toBe("grammar");
  });

  test("falls back to legacy marker/managed pairs on a pre-grammar manifest", () => {
    const map = headSplitEntries(
      manifestText({
        "AGENTS.md": rawLegacy(SENTINEL, "above"),
        ".gitignore": rawLegacy(MANAGED_BEGIN, "below"),
      }),
      "t",
    );
    expect(map.get("AGENTS.md")).toEqual({
      kind: "legacy",
      path: "AGENTS.md",
      marker: SENTINEL,
      managed: "above",
    });
    expect(map.get(".gitignore")?.kind).toBe("legacy");
  });

  test("an unknown grammar is never guessed at - it throws (fail closed)", () => {
    const files = { "AGENTS.md": { class: "split", grammar: "mystery", marker: SENTINEL } };
    expect(() => headSplitEntries(manifestText(files), "t")).toThrow(/refusing to guess/);
  });

  test("a damaged (non-object) entry throws instead of silently skipping its file", () => {
    expect(() => headSplitEntries(manifestText({ "AGENTS.md": null as never }), "t")).toThrow(
      /not an object/,
    );
  });

  test("an empty or non-printable legacy marker throws (fails closed to unverifiable)", () => {
    // managedHalf matches line.trim() === marker, so an EMPTY marker
    // selects the synthetic empty line at EOF: the previous repo-owned
    // half reads as empty and a delivered file could lose every local
    // line while the wire reports clear. Same constraint splitEntries
    // applies to grammar entries.
    expect(() =>
      headSplitEntries(manifestText({ "AGENTS.md": rawLegacy("", "above") }), "t"),
    ).toThrow(/marker\/managed pair/);
    expect(() =>
      headSplitEntries(manifestText({ "AGENTS.md": rawLegacy(`# local §`, "above") }), "t"),
    ).toThrow(/marker\/managed pair/);
  });
});

describe("missingLines", () => {
  test("empty when every non-blank line survives, wherever it moved", () => {
    expect(missingLines("one\ntwo\n", "two\nextra\none\n")).toEqual([]);
  });

  test("names each vanished non-blank line", () => {
    expect(missingLines("one\ntwo\nthree\n", "one\n")).toEqual(["two", "three"]);
  });

  test("blank and whitespace-only lines never count as lost", () => {
    expect(missingLines("one\n\n   \n\t\n", "one\n")).toEqual([]);
  });

  test("occurrence counts are a multiset: a line held twice and delivered once is missing", () => {
    // A plain Set would see "kept" and pass exactly the shrink this wire
    // exists to catch; each previous occurrence must consume one
    // delivered occurrence.
    expect(missingLines("dup\nother\ndup\n", "dup\nother\n")).toEqual(["dup"]);
    expect(missingLines("dup\ndup\n", "dup\ndup\nextra\n")).toEqual([]);
  });

  test("byte-exact: a latin1 byte and its utf-8 spelling are different lines", () => {
    const latin1Line = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("latin1"); // caf\xe9
    const utf8Line = Buffer.from("caf\u00e9", "utf-8").toString("latin1"); // caf\xc3\xa9
    expect(missingLines(`${latin1Line}\n`, `${utf8Line}\n`)).toEqual([latin1Line]);
    expect(missingLines(`${latin1Line}\n`, `${latin1Line}\n`)).toEqual([]);
  });

  test("byte-exact: CRLF and LF spellings of a line are different lines", () => {
    // Split-file repo halves are carried byte-for-byte, so a line-ending
    // flip IS a byte change worth a manual look (warn-cheap by design).
    expect(missingLines("one\r\ntwo\r\n", "one\ntwo\n")).toEqual(["one\r", "two\r"]);
    expect(missingLines("one\r\ntwo\r\n", "one\r\ntwo\r\n")).toEqual([]);
  });
});

describe("compareHalves", () => {
  test("null when the delivered half keeps every line", () => {
    expect(compareHalves(tailEntry(), asHead(tailEntry()), agentsHead, agentsDelivered)).toBeNull();
  });

  test("shrank when a line vanished", () => {
    const delivered = `# AGENTS.md\n\nfresh managed guidance\n\n${SENTINEL}\n\n## Project docs\n`;
    expect(compareHalves(tailEntry(), asHead(tailEntry()), agentsHead, delivered)).toEqual({
      path: "AGENTS.md",
      kind: "shrank",
      missing: ["repo-local instructions"],
    });
  });

  test("each side splits with its OWN marker (marker-rename safety)", () => {
    const oldMarker = "<!-- legacy-marker -->";
    const head = `old managed\n${oldMarker}\nrepo tail\n`;
    const delivered = `new managed\n${SENTINEL}\nrepo tail\n`;
    expect(
      compareHalves(tailEntry(), asHead(tailEntry("AGENTS.md", oldMarker)), head, delivered),
    ).toBeNull();
    // Splitting HEAD with the NEW marker instead would be the mis-split
    // this design rules out: the old copy has no such line.
    expect(compareHalves(tailEntry(), asHead(tailEntry()), head, delivered)?.kind).toBe(
      "unverifiable",
    );
  });

  test("bounded-region: bodies compare, region scaffolding does not", () => {
    const head = regionFile(["local-one", "local-two"], ["*.old"]);
    const kept = regionFile(["local-two", "local-one"], ["*.new"]);
    expect(compareHalves(regionEntry(), asHead(regionEntry()), head, kept)).toBeNull();
    const shrank = regionFile(["local-one"], ["*.new"]);
    expect(compareHalves(regionEntry(), asHead(regionEntry()), head, shrank)).toEqual({
      path: ".gitignore",
      kind: "shrank",
      missing: ["local-two"],
    });
  });

  test("bounded-region: HEAD splits by ITS declared region markers (rename safety)", () => {
    const oldMarkers = {
      begin: "# OLD LOCAL BEGIN",
      end: "# OLD LOCAL END",
      managedBegin: "# OLD MANAGED BEGIN",
      managedEnd: "# OLD MANAGED END",
    };
    const head = `${oldMarkers.begin}\nbody-line\n${oldMarkers.end}\n${oldMarkers.managedBegin}\n${oldMarkers.managedEnd}\n`;
    const delivered = regionFile(["body-line"], ["*.new"]);
    expect(
      compareHalves(regionEntry(), asHead(regionEntry(".gitignore", oldMarkers)), head, delivered),
    ).toBeNull();
    // Splitting HEAD with the NEW region markers would find no region.
    expect(compareHalves(regionEntry(), asHead(regionEntry()), head, delivered)?.kind).toBe(
      "unverifiable",
    );
  });

  test("legacy 'above' pair draws the tail-marker boundary: half against half", () => {
    const head: Parameters<typeof compareHalves>[1] = {
      kind: "legacy",
      path: "AGENTS.md",
      marker: SENTINEL,
      managed: "above",
    };
    expect(compareHalves(tailEntry(), head, agentsHead, agentsDelivered)).toBeNull();
    const shrank = `# AGENTS.md\n\nfresh managed guidance\n\n${SENTINEL}\n`;
    expect(compareHalves(tailEntry(), head, agentsHead, shrank)?.kind).toBe("shrank");
  });

  test("legacy 'below' vs bounded-region: scaffolding never false-fires, lost bodies still do", () => {
    const head: Parameters<typeof compareHalves>[1] = {
      kind: "legacy",
      path: ".gitignore",
      marker: MANAGED_BEGIN,
      managed: "below",
    };
    // The legacy half (everything above MANAGED_BEGIN) includes the
    // LOCAL_BEGIN/END marker lines; they survive in the delivered FILE
    // even though the bounded-region body excludes them.
    const headCopy = regionFile(["keep-me"], ["*.old"]);
    const kept = regionFile(["keep-me"], ["*.new"]);
    expect(compareHalves(regionEntry(), head, headCopy, kept)).toBeNull();
    const dropped = regionFile([], ["*.new"]);
    expect(compareHalves(regionEntry(), head, headCopy, dropped)).toEqual({
      path: ".gitignore",
      kind: "shrank",
      missing: ["keep-me"],
    });
  });

  test("a delivered copy that does not split by the post-sync manifest is unverifiable", () => {
    const finding = compareHalves(
      tailEntry(),
      asHead(tailEntry()),
      agentsHead,
      "render lost its marker\n",
    );
    expect(finding?.kind).toBe("unverifiable");
    expect(finding?.kind === "unverifiable" && finding.reason).toContain("delivered copy");
  });

  test("a grammar change re-splits HEAD under the new grammar when honestly possible", () => {
    // HEAD declared legacy managed-below over a region-shaped file: its
    // copy carries one exactly-once-clean region under the post-sync
    // markers, so THAT body is the honest previous half.
    const head = regionFile(["keep-line"], ["*.old"]);
    const kept = regionFile(["keep-line"], ["*.new"]);
    const legacyHead = {
      kind: "legacy",
      path: ".gitignore",
      marker: MANAGED_BEGIN,
      managed: "below",
    } as const;
    expect(compareHalves(regionEntry(".gitignore"), legacyHead, head, kept)).toBeNull();
    const dropped = regionFile([], ["*.new"]);
    expect(compareHalves(regionEntry(".gitignore"), legacyHead, head, dropped)).toEqual({
      path: ".gitignore",
      kind: "shrank",
      missing: ["keep-line"],
    });
  });

  test("a colliding duplicate across the local body and managed scaffolding still fires", () => {
    // The whole-file fallback this replaced was BLIND here: node_modules/
    // lives in the local body AND the managed half, so its vanished local
    // copy still read as "present anywhere in the file".
    const head = regionFile(["node_modules/", "keep-me"], ["node_modules/", "*.old"]);
    const delivered = regionFile(["keep-me"], ["node_modules/", "*.new"]);
    const legacyHead = {
      kind: "legacy",
      path: ".gitignore",
      marker: MANAGED_BEGIN,
      managed: "below",
    } as const;
    const finding = compareHalves(regionEntry(".gitignore"), legacyHead, head, delivered);
    expect(finding).toEqual({ path: ".gitignore", kind: "shrank", missing: ["node_modules/"] });
  });

  test("a grammar change that cannot be honestly re-split is unverifiable, never silent", () => {
    // HEAD declared tail-marker and carries NO region under the post-sync
    // markers: there is no honest previous half - manual review, not a
    // whole-file survival pass.
    const head = `managed\n${SENTINEL}\nkeep-line\n`;
    const kept = regionFile(["keep-line"], ["*.new"]);
    const finding = compareHalves(
      regionEntry(".gitignore"),
      asHead(tailEntry(".gitignore")),
      head,
      kept,
    );
    expect(finding?.kind).toBe("unverifiable");
    expect(finding?.kind === "unverifiable" && finding.reason).toContain(
      "cannot be honestly re-split",
    );
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
  const headManifest = manifestText({ "AGENTS.md": rawTail() });

  test("clear when the repository-owned half survives a managed-half change", () => {
    const root = makeTarget(
      { "AGENTS.md": agentsHead, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
    expect(result.stdout).toContain("tail tripwire clear");
    expect(result.stdout).not.toContain("::warning::");
  });

  test("fires on a vanished tail line: warns, reports, exits 0", () => {
    const delivered = `# AGENTS.md\n\nfresh managed guidance\n\n${SENTINEL}\n\n## Project docs\n`;
    const root = makeTarget(
      { "AGENTS.md": agentsHead, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    // Warn, not red: a blocked delivery would hide the diff the reviewer
    // needs.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("AGENTS.md: 1 repository-owned line(s) missing");
    expect(result.report).toContain("> [!WARNING]");
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain("repo-local instructions");
  });

  test("a duplicated tail line shrinking to one copy fires: the PR is forced manual", () => {
    // The multiset regression: previous half holds the line TWICE, the
    // delivered half keeps one - a Set-based check would call that clean
    // and leave the shrink auto-merge eligible.
    const head = `# AGENTS.md\n\nmanaged\n\n${SENTINEL}\n\ndup entry\ndup entry\n`;
    const delivered = `# AGENTS.md\n\nmanaged\n\n${SENTINEL}\n\ndup entry\n`;
    const root = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("AGENTS.md: 1 repository-owned line(s) missing");
    expect(result.report).toContain("dup entry");
  });

  test("a NUL-carrying tail line reaches the report escaped, never as a raw control byte", () => {
    // latin1 preserves a NUL byte end to end; raw in the report it would
    // ride into open_pr's --body argv, and OS argv cannot carry NUL - the
    // warn-only wire would become the thing that BLOCKS PR creation.
    const nulLine = "secret\x00control\x01line";
    const head = `# AGENTS.md\n\nmanaged\n\n${SENTINEL}\n\n${nulLine}\n`;
    const delivered = `# AGENTS.md\n\nmanaged\n\n${SENTINEL}\n`;
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
    const spawn = Bun.spawnSync(["true", result.report]);
    expect(spawn.exitCode).toBe(0);
  });

  test("a marker rename cannot mis-split HEAD's copy (HEAD manifest wins there)", () => {
    const oldMarker = "<!-- legacy-marker -->";
    const head = `old managed\n${oldMarker}\nrepo tail line\n`;
    const delivered = `new managed\n${SENTINEL}\nrepo tail line\n`;
    const root = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: manifestText({ "AGENTS.md": rawTail(oldMarker) }) },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: manifestText({ "AGENTS.md": rawTail() }) },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("bounded-region entries split by their region markers, not the managed marker alone", () => {
    const regionManifest = manifestText({ ".gitignore": rawRegion() });
    const head = regionFile(["local-one", "local-two"], ["*.old"]);
    const kept = regionFile(["local-two", "local-one"], ["*.new"]);
    const keptRoot = makeTarget(
      { ".gitignore": head, [MANIFEST_NAME]: regionManifest },
      { ".gitignore": kept, [MANIFEST_NAME]: regionManifest },
    );
    expect(runScript(keptRoot).report).toBe("");
    const shrank = regionFile(["local-one"], ["*.new"]);
    const shrankRoot = makeTarget(
      { ".gitignore": head, [MANIFEST_NAME]: regionManifest },
      { ".gitignore": shrank, [MANIFEST_NAME]: regionManifest },
    );
    const result = runScript(shrankRoot);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("`.gitignore`");
    expect(result.report).toContain("local-two");
  });

  test("a legacy pre-grammar HEAD manifest verifies without false fires", () => {
    // The first post-grammar sync of every fleet repo hits exactly this
    // shape: HEAD's manifest declares only marker/managed pairs.
    const legacyManifest = manifestText({
      "AGENTS.md": rawLegacy(SENTINEL, "above"),
      ".gitignore": rawLegacy(MANAGED_BEGIN, "below"),
    });
    const newManifest = manifestText({ "AGENTS.md": rawTail(), ".gitignore": rawRegion() });
    const gitignoreHead = regionFile(["keep-me"], ["*.old"]);
    const root = makeTarget(
      { "AGENTS.md": agentsHead, ".gitignore": gitignoreHead, [MANIFEST_NAME]: legacyManifest },
      {
        "AGENTS.md": agentsDelivered,
        ".gitignore": regionFile(["keep-me"], ["*.new"]),
        [MANIFEST_NAME]: newManifest,
      },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
    // And a genuinely dropped local body line still fires through the
    // legacy path.
    const shrankRoot = makeTarget(
      { ".gitignore": gitignoreHead, [MANIFEST_NAME]: legacyManifest },
      { ".gitignore": regionFile([], ["*.new"]), [MANIFEST_NAME]: newManifest },
    );
    expect(runScript(shrankRoot).report).toContain("keep-me");
  });

  test("non-UTF-8 tail bytes compare byte-for-byte and never false-fire", () => {
    const tailBytes = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9])]);
    const head = Buffer.concat([Buffer.from(`old\n${SENTINEL}\n`), tailBytes, Buffer.from("\n")]);
    const delivered = Buffer.concat([
      Buffer.from(`new\n${SENTINEL}\n`),
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
      { "AGENTS.md": `new\n${SENTINEL}\n`, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(shrankRoot);
    expect(result.report).toContain("caf\u00e9");
    expect(result.report).not.toContain("\ufffd");
  });

  test("blank lines dropped from the previous tail never fire", () => {
    const head = `old\n${SENTINEL}\n\nkeep me\n   \n\n`;
    const delivered = `new\n${SENTINEL}\nkeep me\n`;
    const root = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: headManifest },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: headManifest },
    );
    expect(runScript(root).report).toBe("");
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
    // repository-owned half here, so there is nothing this wire guards.
    const root = makeTarget(
      {
        "AGENTS.md": "wholly managed before, no marker\n",
        [MANIFEST_NAME]: manifestText({ "AGENTS.md": { class: "managed" } }),
      },
      { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("a HEAD without a usable manifest makes its split files unverifiable, not red", () => {
    const root = makeTarget(
      { "AGENTS.md": agentsHead },
      { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.report).toContain("no usable ownership manifest");
  });

  test("an unparseable HEAD manifest is treated like a missing one", () => {
    const root = makeTarget(
      { "AGENTS.md": agentsHead, [MANIFEST_NAME]: "{ not json" },
      { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("no usable ownership manifest");
  });

  test("an unknown grammar in the HEAD manifest is unverifiable, not guessed", () => {
    const mystery = manifestText({
      "AGENTS.md": { class: "split", grammar: "mystery", marker: SENTINEL },
    });
    const root = makeTarget(
      { "AGENTS.md": agentsHead, [MANIFEST_NAME]: mystery },
      { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("no usable ownership manifest");
  });

  test("a HEAD manifest with a damaged entry is unverifiable, not silently skipped", () => {
    const damaged = manifestText({ "AGENTS.md": null as never });
    const root = makeTarget(
      { "AGENTS.md": agentsHead, [MANIFEST_NAME]: damaged },
      { "AGENTS.md": agentsDelivered, [MANIFEST_NAME]: headManifest },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("no usable ownership manifest");
  });

  test("an unknown grammar in the POST-SYNC manifest is a broken input and goes red", () => {
    // Our own render produced this manifest; refusing to guess matches
    // preserve_local_content's discipline.
    const mystery = manifestText({
      "AGENTS.md": { class: "split", grammar: "mystery", marker: SENTINEL },
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
    const delivered = `# AGENTS.md\n\nfresh managed guidance\n\n${SENTINEL}\n`;
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
