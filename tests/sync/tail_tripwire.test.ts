// tail_tripwire.ts: the post-stamp defense-in-depth check that no split
// file's repository-owned half lost non-blank lines it held at the
// target's HEAD. The script-level tests build a real git repo whose HEAD
// carries both the previous file copies and the previous manifest, then
// overwrite the working tree with the "delivered" state - exactly the
// shape the sync leg hands the tripwire.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  compareHalves,
  missingLines,
  renderReport,
  repoOwnedHalf,
} from "../../.github/scripts/sync/tail_tripwire.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/tail_tripwire.ts");

const SENTINEL = "<!-- repo-platform:local-section -->";
const MANIFEST_NAME = ".github/repo-platform-manifest.json";

const agentsHead = `# AGENTS.md\n\nold managed guidance\n\n${SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`;
const agentsDelivered = `# AGENTS.md\n\nfresh managed guidance\n\n${SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`;

type Entry = { class: string; marker?: string; managed?: string };

function manifestText(files: Record<string, Entry>): string {
  return `${JSON.stringify({ files }, null, 2)}\n`;
}

const splitAbove = (marker: string = SENTINEL): Entry => ({
  class: "split",
  marker,
  managed: "above",
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
    {
      env: gitFreeEnv(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    report: existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "",
  };
}

describe("repoOwnedHalf", () => {
  test("managed above: the half below the marker line", () => {
    expect(repoOwnedHalf(`managed\n${SENTINEL}\ntail\n`, SENTINEL, "above")).toBe("tail\n");
  });

  test("managed below: the half above the marker line", () => {
    expect(repoOwnedHalf("local\n\n# MARKER\nmanaged\n", "# MARKER", "below")).toBe("local\n\n");
  });

  test("missing marker line means no honest split", () => {
    expect(repoOwnedHalf("no marker here\n", SENTINEL, "above")).toBeNull();
  });

  test("managed and repo-owned halves partition the content exactly", () => {
    const content = `a\n${SENTINEL}\nb\n`;
    expect(repoOwnedHalf(content, SENTINEL, "above")).toBe("b\n");
    expect(`a\n${SENTINEL}\n${repoOwnedHalf(content, SENTINEL, "above")}`).toBe(content);
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
    expect(
      compareHalves("AGENTS.md", splitAbove(), splitAbove(), agentsHead, agentsDelivered),
    ).toBeNull();
  });

  test("shrank when a line vanished", () => {
    const delivered = `# AGENTS.md\n\nfresh managed guidance\n\n${SENTINEL}\n\n## Project docs\n`;
    expect(compareHalves("AGENTS.md", splitAbove(), splitAbove(), agentsHead, delivered)).toEqual({
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
      compareHalves("AGENTS.md", splitAbove(), splitAbove(oldMarker), head, delivered),
    ).toBeNull();
    // Splitting HEAD with the NEW marker instead would be the mis-split
    // this design rules out: the old copy has no such line.
    expect(compareHalves("AGENTS.md", splitAbove(), splitAbove(), head, delivered)?.kind).toBe(
      "unverifiable",
    );
  });

  test("a delivered copy without its manifest marker is unverifiable", () => {
    const finding = compareHalves(
      "AGENTS.md",
      splitAbove(),
      splitAbove(),
      agentsHead,
      "render lost its marker\n",
    );
    expect(finding?.kind).toBe("unverifiable");
    expect(finding?.kind === "unverifiable" && finding.reason).toContain("delivered copy");
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

  test("an enormous unverifiable reason (HEAD-manifest text) is bounded too", () => {
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
  const headManifest = manifestText({ "AGENTS.md": splitAbove() });

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

  test("a marker rename cannot mis-split HEAD's copy (HEAD manifest wins there)", () => {
    const oldMarker = "<!-- legacy-marker -->";
    const head = `old managed\n${oldMarker}\nrepo tail line\n`;
    const delivered = `new managed\n${SENTINEL}\nrepo tail line\n`;
    const root = makeTarget(
      { "AGENTS.md": head, [MANIFEST_NAME]: manifestText({ "AGENTS.md": splitAbove(oldMarker) }) },
      { "AGENTS.md": delivered, [MANIFEST_NAME]: manifestText({ "AGENTS.md": splitAbove() }) },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("managed-below entries guard the half above the marker (.gitignore shape)", () => {
    const marker = "# BEGIN REPO-PLATFORM MANAGED";
    const gitignoreEntry = manifestText({
      ".gitignore": { class: "split", marker, managed: "below" },
    });
    const head = `local-one\nlocal-two\n\n${marker}\n*.old\n`;
    const kept = `local-two\nlocal-one\n${marker}\n*.new\n`;
    const shrank = `local-one\n${marker}\n*.new\n`;
    const keptRoot = makeTarget(
      { ".gitignore": head, [MANIFEST_NAME]: gitignoreEntry },
      { ".gitignore": kept, [MANIFEST_NAME]: gitignoreEntry },
    );
    expect(runScript(keptRoot).report).toBe("");
    const shrankRoot = makeTarget(
      { ".gitignore": head, [MANIFEST_NAME]: gitignoreEntry },
      { ".gitignore": shrank, [MANIFEST_NAME]: gitignoreEntry },
    );
    const result = runScript(shrankRoot);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("`.gitignore`");
    expect(result.report).toContain("local-two");
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
