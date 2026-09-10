// The copy writer end to end: sync.ts as a subprocess over the fixture
// files/ tree and a fixture git checkout carrying every state the writer
// judges (a local edit in a managed file, a repo-owned tail in a split file,
// an existing starter, a clean and an edited retired file, a move, a mirror
// and a foreign mirror copy, an unknown module, a symlink recorded by the
// previous pipeline at a link path and at a path nothing selects, a class
// flip that matches its record and one that does not). The written tree,
// the manifest, the report sections, the summary, and idempotence are
// asserted; the code under test is reached only through the subprocess.

import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const FIXTURES = join(import.meta.dir, "sync_end_to_end/fixtures");
const BUILD = "abcdef0123456789abcdef0123456789abcdef01";
const MANIFEST = ".github/repo-platform-manifest.json";
const YEAR = String(new Date().getUTCFullYear());

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const HASH_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const HASH_END = "# END REPO-PLATFORM MANAGED";
const OLD_REGION = `${HASH_BEGIN}\n# old managed region\nnode_modules/\n${HASH_END}\n`;
const OLD_LICENSE = "MIT License\n\nCopyright (c) 2020 Someone\n";
const OLD_CI = "name: platform ci v1\n";
const LOCAL_CI = "name: my own ci\non: push\n";
const OLD_ANSWERS = "_commit: 0000000000000000000000000000000000000000\n";
const RELEASE_EDITED = "name: release (hand tuned)\n";
const OLD_SECURITY = "# Security policy (old home)\n";
const STARTER = "name: my fuzz\non: workflow_dispatch\n";
const OLD_STARTER = "name: an old starter, still mine\n";
const OLD_NOTES = "# Notes (old home)\n";
const OLD_EDITORCONFIG = "root = true\nindent_style = space\n";
const OLD_GITATTRIBUTES = "* text=auto eol=lf\n";
const OLD_YAMLLINT = "rules: {}\n";
const LOCAL_CONSTRUCTOR = "local notes\n";

/** The old pipeline's manifest layout for the seeded files. */
function oldManifest(): string {
  const entries: Record<string, string> = {
    ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha256(OLD_CI)}"}`,
    "LICENSE.md": `{"class": "managed", "hash": "${sha256(OLD_LICENSE)}"}`,
    ".gitignore": `{"class": "split", "grammar": "managed-region", "begin": "${HASH_BEGIN}", "end": "${HASH_END}", "hash": "${sha256(OLD_REGION)}"}`,
    ".github/.copier-answers.yml": `{"class": "managed", "hash": "${sha256(OLD_ANSWERS)}"}`,
    ".github/workflows/release.yml": `{"class": "managed", "hash": "${sha256("name: release\n")}"}`,
    "SECURITY.md": `{"class": "managed", "hash": "${sha256(OLD_SECURITY)}"}`,
    "OLD_NOTES.md": `{"class": "managed", "hash": "${sha256(OLD_NOTES)}"}`,
    ".github/workflows/nightly-fuzz.yml": `{"class": "starter"}`,
    ".github/workflows/old-starter.yml": `{"class": "starter"}`,
    ".github/workflows/deselected-starter.yml": `{"class": "starter"}`,
    "skills/gamma/LICENSE.md": `{"class": "mirror", "hash": "${sha256(OLD_LICENSE)}"}`,
    // The previous pipeline recorded its symlinks as managed, hashing the
    // link target string.
    "CLAUDE.md": `{"class": "managed", "hash": "${sha256("AGENTS.md")}"}`,
    ".github/copilot-instructions.md": `{"class": "managed", "hash": "${sha256("../AGENTS.md")}"}`,
    // Two managed records whose entries are split now: one still the
    // recorded content, one edited since.
    ".editorconfig": `{"class": "managed", "hash": "${sha256(OLD_EDITORCONFIG)}"}`,
    ".gitattributes": `{"class": "managed", "hash": "${sha256("* text=auto\n")}"}`,
    // A managed record without a hash is one the writer cannot carry, so it
    // is no record at all, and no class flip.
    ".yamllint": `{"class": "managed", "hash": null}`,
    // A starter flipping to managed is held; its path is named like an
    // inherited object property to keep every record lookup honest.
    constructor: `{"class": "starter"}`,
    "../escape.txt": `{"class": "managed", "hash": "${sha256("x")}"}`,
    [MANIFEST]: `{"class": "managed", "hash": null, "commit": "1111111111111111111111111111111111111111"}`,
  };
  const lines = Object.entries(entries).map(
    ([path, body]) => `    ${JSON.stringify(path)}: ${body}`,
  );
  return `{\n  "files": {\n${lines.join(",\n")}\n  }\n}\n`;
}

function seedTarget(): string {
  const target = temp.dir("sync-e2e-target-");
  const files: Record<string, string> = {
    ".repo-platform.yml": [
      "modules: [bun, node, docs-site, fuzzer, skills, uv]",
      "project: {name: Demo Project, slug: demo, description: A demo repository}",
      "labels: {fuzzer: fuzz-me}",
      "mirrors:",
      "  - {source: LICENSE.md, targets: [skills/*/LICENSE.md, .github/repo-platform-manifest.json]}",
      "  - {source: .gitattributes, targets: [docs/gitattributes.txt]}",
      "",
    ].join("\n"),
    ".github/workflows/ci.yml": LOCAL_CI,
    "LICENSE.md": OLD_LICENSE,
    ".gitignore": `# my ignores above\n${OLD_REGION}# my ignores below\n.idea/\n`,
    ".github/.copier-answers.yml": OLD_ANSWERS,
    ".github/workflows/release.yml": RELEASE_EDITED,
    "SECURITY.md": OLD_SECURITY,
    "OLD_NOTES.md": OLD_NOTES,
    ".github/workflows/nightly-fuzz.yml": STARTER,
    ".github/workflows/old-starter.yml": OLD_STARTER,
    ".github/workflows/deselected-starter.yml": OLD_STARTER,
    "skills/alpha/README.md": "alpha\n",
    "skills/beta/README.md": "beta\n",
    "skills/beta/LICENSE.md": "a hand-written license\n",
    "skills/gamma/README.md": "gamma\n",
    "skills/gamma/LICENSE.md": "an edited mirror copy\n",
    ".editorconfig": OLD_EDITORCONFIG,
    ".gitattributes": OLD_GITATTRIBUTES,
    ".yamllint": OLD_YAMLLINT,
    constructor: LOCAL_CONSTRUCTOR,
    [MANIFEST]: oldManifest(),
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), content);
  }
  // An executable whose class flips must keep its mode.
  chmodSync(join(target, ".editorconfig"), 0o755);
  symlinkSync("AGENTS.md", join(target, "CLAUDE.md"));
  symlinkSync("../AGENTS.md", join(target, ".github/copilot-instructions.md"));
  fixtureGit(target, ["init", "-q", "-b", "main"]);
  fixtureGit(target, ["add", "-A"]);
  fixtureGit(target, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "seed"]);
  return target;
}

/** Every file under `root` (the .git directory aside) with its content
 *  hash, a symlink by its target: the idempotence oracle. */
function snapshot(root: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (rel === ".git") continue;
    if (entry.isDirectory()) {
      for (const [path, hash] of snapshot(root, rel)) out.set(path, hash);
    } else if (entry.isSymbolicLink()) {
      out.set(rel, `-> ${readlinkSync(join(root, rel))}`);
    } else {
      out.set(rel, sha256(readFileSync(join(root, rel), "latin1")));
    }
  }
  return out;
}

interface Summary {
  hold: boolean;
  holdReasons: string[];
  modules: string[];
  written: { path: string; class: string; change: string; detail: string }[];
  retired: { path: string; outcome: string; detail: string }[];
  mirrors: { source: string; target: string; outcome: string }[];
  notes: string[];
}

function runSync(target: string, summaryPath: string): { stdout: string; summary: Summary } {
  const result = boundedSpawnSync(
    [
      "bun",
      SYNC,
      "--files",
      join(FIXTURES, "files.yml"),
      "--tree",
      join(FIXTURES, "files"),
      "--target",
      target,
      "--build",
      BUILD,
      "--repository",
      "OwnerOrg/demo",
      "--private",
      "false",
      "--summary",
      summaryPath,
    ],
    { cwd: REPO_ROOT, env: fixtureGitEnv(), timeoutMs: 60_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return { stdout: result.stdout, summary: JSON.parse(readFileSync(summaryPath, "utf-8")) };
}

describe("sync.ts end to end", () => {
  let target: string;
  let stdout: string;
  let summary: Summary;
  let seeded: Map<string, string>;
  const read = (rel: string) => readFileSync(join(target, rel), "utf-8");

  beforeAll(() => {
    target = seedTarget();
    seeded = snapshot(target);
    ({ stdout, summary } = runSync(target, join(temp.dir("sync-e2e-summary-"), "summary.json")));
  });

  test("selects the known modules; unknown modules and unsafe records become notes", () => {
    expect(summary.modules).toEqual(["bun", "node", "docs-site", "fuzzer", "skills"]);
    expect(summary.notes).toEqual([
      "dropped unknown module `uv` (files.yml does not know it)",
      "manifest record for `../escape.txt` ignored: the path carries an empty, '.', or '..' segment",
    ]);
  });

  test("writes each class with the right change verdict", () => {
    const row = (path: string, cls: string, change: string, detail = "") => ({
      path,
      class: cls,
      change,
      detail,
    });
    expect(summary.written).toEqual([
      row(".github/workflows/ci.yml", "managed", "replaced local edits"),
      row("LICENSE.md", "managed", "updated"),
      row(".github/SECURITY.md", "managed", "updated"),
      row(".gitignore", "split", "updated"),
      row("AGENTS.md", "split", "created"),
      row("CLAUDE.md", "link", "unchanged"),
      row(".github/agents.md", "link", "created"),
      row(".github/dependabot.yml", "managed", "created"),
      row(".github/workflows/checks.yml", "starter", "created"),
      row(".editorconfig", "split", "updated"),
      row(
        ".gitattributes",
        "split",
        "held",
        "class changed from managed to split, and the content differs from the last write",
      ),
      row(".yamllint", "split", "updated"),
      row(
        "constructor",
        "managed",
        "held",
        "class changed from starter to managed, and a starter is repo-owned",
      ),
      row(".github/workflows/docs-site.yml", "managed", "created"),
      row(".github/workflows/nightly-fuzz.yml", "starter", "unchanged"),
      row(".github/workflows/validate-skills.yml", "managed", "created"),
    ]);
    expect(existsSync(join(target, ".github/workflows/private-only.yml"))).toBe(false);
  });

  test("a class flip replaces the recorded content whole and holds anything else", () => {
    // .editorconfig was exactly its managed record: the region alone now, mode kept.
    expect(read(".editorconfig")).toBe(`${HASH_BEGIN}\nroot = true\n${HASH_END}\n`);
    expect(lstatSync(join(target, ".editorconfig")).mode & 0o111).toBe(0o111);
    // .gitattributes was edited since its record: untouched, no region prepended.
    expect(read(".gitattributes")).toBe(OLD_GITATTRIBUTES);
    // .yamllint's record had no hash: no flip, the split writer keeps the content below.
    expect(read(".yamllint")).toBe(`${HASH_BEGIN}\nextends: default\n${HASH_END}\n${OLD_YAMLLINT}`);
    expect(read("constructor")).toBe(LOCAL_CONSTRUCTOR);
  });

  test("links: the recorded symlink is adopted, the new one created, the stale one removed", () => {
    expect(readlinkSync(join(target, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(readlinkSync(join(target, ".github/agents.md"))).toBe("../AGENTS.md");
    expect(lstatSync(join(target, ".github/agents.md")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, ".github/copilot-instructions.md"))).toBe(false);
    expect(read("AGENTS.md")).toContain("# Demo Project");
  });

  test("blocks land at the anchor line of a managed file and at the end of a starter", () => {
    expect(read(".github/dependabot.yml")).toBe(
      [
        "version: 2",
        "updates:",
        '  - package-ecosystem: "bun"',
        '    directory: "/"',
        '  - package-ecosystem: "npm"',
        '    directory: "/"',
        "# end of updates",
        "",
      ].join("\n"),
    );
    expect(read(".github/workflows/checks.yml")).toBe(
      "name: checks\non: pull_request\njobs: {}\n# Examples:\n#   bun test\n",
    );
  });

  test("substitutes placeholders and leaves Actions expressions alone", () => {
    expect(read(".github/workflows/ci.yml")).toContain('name: "Demo Project CI"');
    expect(read(".github/workflows/ci.yml")).toContain('"${{ github.sha }} for ownerorg/demo"');
    // The registration's label wins; the skills directory falls back to the module default.
    expect(read(".github/workflows/ci.yml")).toContain('echo "tracking fuzz-me"');
    expect(read(".github/workflows/validate-skills.yml")).toContain('paths: ["skills/**"]');
    expect(read("LICENSE.md")).toBe(`MIT License\n\nCopyright (c) ${YEAR} OwnerOrg\n`);
    expect(read("AGENTS.md")).toBe(
      "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Demo Project\n\nA demo repository\n<!-- END REPO-PLATFORM MANAGED -->\n",
    );
    expect(read(".github/workflows/docs-site.yml")).toContain("docs site (standalone)");
  });

  test("rewrites the split region between the repo-owned halves with the module blocks, one Node block for two modules", () => {
    expect(read(".gitignore")).toBe(
      [
        "# my ignores above",
        HASH_BEGIN,
        "# Generated from github/gitignore - do not edit between the markers.",
        "node_modules/",
        "## Node",
        "*.log",
        "## Bun",
        "bun.lockb",
        HASH_END,
        "# my ignores below",
        ".idea/",
        "",
      ].join("\n"),
    );
  });

  test("never touches the existing starters, selected or retired", () => {
    expect(read(".github/workflows/nightly-fuzz.yml")).toBe(STARTER);
    expect(read(".github/workflows/old-starter.yml")).toBe(OLD_STARTER);
  });

  test("retires: deletes the clean file, holds the edited one, moves the relocated one", () => {
    expect(summary.retired).toEqual([
      { path: ".github/.copier-answers.yml", outcome: "deleted", detail: "retired" },
      {
        path: ".github/workflows/release.yml",
        outcome: "held",
        detail: "the content differs from the last write",
      },
      { path: "SECURITY.md", outcome: "moved", detail: "to .github/SECURITY.md" },
      {
        path: ".github/workflows/old-starter.yml",
        outcome: "kept",
        detail: "a starter is repo-owned",
      },
      {
        path: "OLD_NOTES.md",
        outcome: "deleted",
        detail: "retired (its new home docs/NOTES.md is not selected here)",
      },
      {
        path: ".github/copilot-instructions.md",
        outcome: "deleted",
        detail: "no longer selected",
      },
    ]);
    expect(summary.retired.map((row) => row.path)).not.toContain("CLAUDE.md");
    expect(existsSync(join(target, ".github/.copier-answers.yml"))).toBe(false);
    // The destination is gated on an unselected module: nothing moves there.
    expect(existsSync(join(target, "OLD_NOTES.md"))).toBe(false);
    expect(existsSync(join(target, "docs/NOTES.md"))).toBe(false);
    expect(read(".github/workflows/release.yml")).toBe(RELEASE_EDITED);
    expect(existsSync(join(target, "SECURITY.md"))).toBe(false);
    expect(read(".github/SECURITY.md")).toContain("Report issues to OwnerOrg privately.");
  });

  test("mirrors the written license into each skill, refusing the foreign copies", () => {
    expect(summary.mirrors).toEqual([
      expect.objectContaining({
        target: MANIFEST,
        outcome: "refused",
        detail: "the pattern is a path files.yml writes",
      }),
      expect.objectContaining({ target: "skills/alpha/LICENSE.md", outcome: "written" }),
      expect.objectContaining({ target: "skills/beta/LICENSE.md", outcome: "refused" }),
      expect.objectContaining({ target: "skills/gamma/LICENSE.md", outcome: "refused" }),
      expect.objectContaining({
        source: ".gitattributes",
        target: "docs/gitattributes.txt",
        outcome: "refused",
        detail: "the source is not a file this sync writes",
      }),
    ]);
    expect(existsSync(join(target, "docs/gitattributes.txt"))).toBe(false);
    expect(read("skills/alpha/LICENSE.md")).toBe(read("LICENSE.md"));
    expect(read("skills/beta/LICENSE.md")).toBe("a hand-written license\n");
    expect(read("skills/gamma/LICENSE.md")).toBe("an edited mirror copy\n");
  });

  test("records what it wrote in the manifest, the build on the self entry", () => {
    const manifest = JSON.parse(read(MANIFEST)) as {
      files: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(manifest.files).sort()).toEqual(
      [
        MANIFEST,
        ".github/workflows/ci.yml",
        "LICENSE.md",
        ".github/SECURITY.md",
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        ".github/agents.md",
        ".github/dependabot.yml",
        ".github/workflows/checks.yml",
        ".editorconfig",
        ".gitattributes",
        ".yamllint",
        "constructor",
        ".github/workflows/docs-site.yml",
        ".github/workflows/nightly-fuzz.yml",
        ".github/workflows/validate-skills.yml",
        ".github/workflows/old-starter.yml",
        ".github/workflows/deselected-starter.yml",
        ".github/workflows/release.yml",
        "skills/alpha/LICENSE.md",
        "skills/gamma/LICENSE.md",
      ].sort(),
    );
    expect(manifest.files[MANIFEST]).toEqual({ class: "managed", hash: null, commit: BUILD });
    expect(manifest.files["LICENSE.md"]).toEqual({
      class: "managed",
      hash: sha256(read("LICENSE.md")),
    });
    expect(manifest.files["skills/alpha/LICENSE.md"]).toEqual({
      class: "mirror",
      hash: sha256(read("LICENSE.md")),
    });
    expect(manifest.files[".github/workflows/nightly-fuzz.yml"]).toEqual({ class: "starter" });
    // The adopted symlink's record flips to link with the hash the previous
    // pipeline already wrote; the held flip keeps its managed record.
    expect(manifest.files["CLAUDE.md"]).toEqual({ class: "link", hash: sha256("AGENTS.md") });
    expect(manifest.files[".github/agents.md"]).toEqual({
      class: "link",
      hash: sha256("../AGENTS.md"),
    });
    expect(manifest.files[".gitattributes"]).toEqual({
      class: "managed",
      hash: sha256("* text=auto\n"),
    });
    expect(Object.entries(manifest.files).find(([path]) => path === "constructor")?.[1]).toEqual({
      class: "starter",
    });
    expect(manifest.files[".editorconfig"]).toMatchObject({
      class: "split",
      hash: sha256(read(".editorconfig")),
    });
    // Kept and refused files keep their previous records, so a later sync
    // can still recognise the platform's last write.
    expect(manifest.files[".github/workflows/old-starter.yml"]).toEqual({ class: "starter" });
    expect(manifest.files[".github/workflows/deselected-starter.yml"]).toEqual({
      class: "starter",
    });
    expect(read(".github/workflows/deselected-starter.yml")).toBe(OLD_STARTER);
    expect(manifest.files["docs/NOTES.md"]).toBeUndefined();
    expect(manifest.files["skills/gamma/LICENSE.md"]).toEqual({
      class: "mirror",
      hash: sha256(OLD_LICENSE),
    });
    const gitignore = read(".gitignore");
    const region = gitignore.slice(
      gitignore.indexOf(HASH_BEGIN),
      gitignore.indexOf(HASH_END) + HASH_END.length + 1,
    );
    expect(manifest.files[".gitignore"]).toEqual({
      class: "split",
      grammar: "managed-region",
      begin: HASH_BEGIN,
      end: HASH_END,
      hash: sha256(region),
    });
    expect(manifest.files[".github/workflows/release.yml"]).toEqual({
      class: "managed",
      hash: sha256("name: release\n"),
    });
  });

  test("the report carries every section and holds for review", () => {
    for (const heading of [
      "## Sync report",
      "### Written",
      "### Replaced local edits",
      "### Retired",
      "### Registration notes",
      "### Mirrors",
      "### Review",
    ]) {
      expect(stdout).toContain(heading);
    }
    expect(stdout).toContain(
      `| \`${BUILD}\` | \`bun\`, \`node\`, \`docs-site\`, \`fuzzer\`, \`skills\` | public |`,
    );
    expect(stdout).toContain(
      "| `.gitattributes` | split | held | class changed from managed to split, and the content differs from the last write |",
    );
    expect(stdout).toContain(
      '```diff\n--- .github/workflows/ci.yml\n+++ .github/workflows/ci.yml\n@@\n-name: my own ci\n-on: push\n+name: "Demo Project CI"',
    );
    expect(summary.hold).toBe(true);
    expect(summary.holdReasons).toEqual([
      ".gitattributes held: class changed from managed to split, and the content differs from the last write",
      "constructor held: class changed from starter to managed, and a starter is repo-owned",
      "local edits replaced in .github/workflows/ci.yml",
      "retirement of .github/workflows/release.yml held: the content differs from the last write",
      `mirror ${MANIFEST} refused: the pattern is a path files.yml writes`,
      "mirror skills/beta/LICENSE.md refused: the target holds content that is not the previous mirror",
      "mirror skills/gamma/LICENSE.md refused: the target holds content that is not the previous mirror",
      "mirror docs/gitattributes.txt refused: the source is not a file this sync writes",
      "registration: dropped unknown module `uv` (files.yml does not know it)",
      "registration: manifest record for `../escape.txt` ignored: the path carries an empty, '.', or '..' segment",
    ]);
  });

  test("a second run changes no byte and reports every file unchanged", () => {
    const before = snapshot(target);
    // Control: the oracle sees the first run's changes, so an equal
    // snapshot below is evidence, not a blind comparison.
    expect(before).not.toEqual(seeded);
    const again = runSync(target, join(temp.dir("sync-e2e-summary2-"), "summary.json"));
    expect(again.summary.written.map((row) => row.change)).toEqual(
      summary.written.map((row) => (row.change === "held" ? "held" : "unchanged")),
    );
    expect(again.summary.retired).toEqual([
      {
        path: ".github/workflows/release.yml",
        outcome: "held",
        detail: "the content differs from the last write",
      },
      {
        path: ".github/workflows/old-starter.yml",
        outcome: "kept",
        detail: "a starter is repo-owned",
      },
    ]);
    // The local edit is gone and the unsafe record left the manifest; the
    // other reasons stand until a human acts.
    expect(again.summary.holdReasons).toEqual(
      summary.holdReasons.filter(
        (r) => !r.startsWith("local edits") && !r.includes("manifest record"),
      ),
    );
    expect(snapshot(target)).toEqual(before);
  });
});
