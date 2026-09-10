// The copy writer end to end: sync.ts as a subprocess over the fixture
// files/ tree and a fixture git checkout carrying every state the writer
// judges (a local edit in a managed file, a repo-owned tail in a split file,
// an existing starter, a clean and an edited retired file, a move, a mirror
// and a foreign mirror copy, an unknown module). The written tree, the
// manifest, the report sections, the summary, and idempotence are asserted;
// the code under test is reached only through the subprocess.

import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** The old pipeline's manifest layout for the seeded files. */
function oldManifest(): string {
  const entries: Record<string, string> = {
    ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha256(OLD_CI)}"}`,
    "LICENSE.md": `{"class": "managed", "hash": "${sha256(OLD_LICENSE)}"}`,
    ".gitignore": `{"class": "split", "grammar": "managed-region", "begin": "${HASH_BEGIN}", "end": "${HASH_END}", "hash": "${sha256(OLD_REGION)}"}`,
    ".github/.copier-answers.yml": `{"class": "managed", "hash": "${sha256(OLD_ANSWERS)}"}`,
    ".github/workflows/release.yml": `{"class": "managed", "hash": "${sha256("name: release\n")}"}`,
    "SECURITY.md": `{"class": "managed", "hash": "${sha256(OLD_SECURITY)}"}`,
    ".github/workflows/nightly-fuzz.yml": `{"class": "starter"}`,
    ".github/workflows/old-starter.yml": `{"class": "starter"}`,
    "skills/gamma/LICENSE.md": `{"class": "mirror", "hash": "${sha256(OLD_LICENSE)}"}`,
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
      "modules: [bun, docs-site, fuzzer, uv]",
      "project: {name: Demo Project, slug: demo, description: A demo repository}",
      "mirrors:",
      "  - {source: LICENSE.md, targets: [skills/*/LICENSE.md]}",
      "",
    ].join("\n"),
    ".github/workflows/ci.yml": LOCAL_CI,
    "LICENSE.md": OLD_LICENSE,
    ".gitignore": `# my ignores above\n${OLD_REGION}# my ignores below\n.idea/\n`,
    ".github/.copier-answers.yml": OLD_ANSWERS,
    ".github/workflows/release.yml": RELEASE_EDITED,
    "SECURITY.md": OLD_SECURITY,
    ".github/workflows/nightly-fuzz.yml": STARTER,
    ".github/workflows/old-starter.yml": OLD_STARTER,
    "skills/alpha/README.md": "alpha\n",
    "skills/beta/README.md": "beta\n",
    "skills/beta/LICENSE.md": "a hand-written license\n",
    "skills/gamma/README.md": "gamma\n",
    "skills/gamma/LICENSE.md": "an edited mirror copy\n",
    [MANIFEST]: oldManifest(),
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), content);
  }
  fixtureGit(target, ["init", "-q", "-b", "main"]);
  fixtureGit(target, ["add", "-A"]);
  fixtureGit(target, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "seed"]);
  return target;
}

/** Every regular file under `root` (the .git directory aside) with its
 *  content hash: the idempotence oracle. */
function snapshot(root: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (rel === ".git") continue;
    if (entry.isDirectory()) {
      for (const [path, hash] of snapshot(root, rel)) out.set(path, hash);
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
  written: { path: string; class: string; change: string }[];
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
    expect(summary.modules).toEqual(["bun", "docs-site", "fuzzer"]);
    expect(summary.notes).toEqual([
      "dropped unknown module `uv` (files.yml does not know it)",
      "manifest record for `../escape.txt` ignored: the path carries an empty, '.', or '..' segment",
    ]);
  });

  test("writes each class with the right change verdict", () => {
    expect(summary.written).toEqual([
      { path: ".github/workflows/ci.yml", class: "managed", change: "replaced local edits" },
      { path: "LICENSE.md", class: "managed", change: "updated" },
      { path: ".github/SECURITY.md", class: "managed", change: "updated" },
      { path: ".gitignore", class: "split", change: "updated" },
      { path: "AGENTS.md", class: "split", change: "created" },
      { path: ".github/workflows/docs-site.yml", class: "managed", change: "created" },
      { path: ".github/workflows/nightly-fuzz.yml", class: "starter", change: "unchanged" },
    ]);
    expect(existsSync(join(target, ".github/workflows/private-only.yml"))).toBe(false);
  });

  test("substitutes placeholders and leaves Actions expressions alone", () => {
    expect(read(".github/workflows/ci.yml")).toContain('name: "Demo Project CI"');
    expect(read(".github/workflows/ci.yml")).toContain('"${{ github.sha }} for ownerorg/demo"');
    expect(read("LICENSE.md")).toBe(`MIT License\n\nCopyright (c) ${YEAR} OwnerOrg\n`);
    expect(read("AGENTS.md")).toBe(
      "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Demo Project\n\nA demo repository\n<!-- END REPO-PLATFORM MANAGED -->\n",
    );
    expect(read(".github/workflows/docs-site.yml")).toContain("docs site (standalone)");
  });

  test("rewrites the split region between the repo-owned halves with the module blocks", () => {
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
    ]);
    expect(existsSync(join(target, ".github/.copier-answers.yml"))).toBe(false);
    expect(read(".github/workflows/release.yml")).toBe(RELEASE_EDITED);
    expect(existsSync(join(target, "SECURITY.md"))).toBe(false);
    expect(read(".github/SECURITY.md")).toContain("Report issues to OwnerOrg privately.");
  });

  test("mirrors the written license into each skill, refusing the foreign copies", () => {
    expect(summary.mirrors).toEqual([
      expect.objectContaining({ target: "skills/alpha/LICENSE.md", outcome: "written" }),
      expect.objectContaining({ target: "skills/beta/LICENSE.md", outcome: "refused" }),
      expect.objectContaining({ target: "skills/gamma/LICENSE.md", outcome: "refused" }),
    ]);
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
        ".github/workflows/docs-site.yml",
        ".github/workflows/nightly-fuzz.yml",
        ".github/workflows/old-starter.yml",
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
    // Kept and refused files keep their previous records, so a later sync
    // can still recognise the platform's last write.
    expect(manifest.files[".github/workflows/old-starter.yml"]).toEqual({ class: "starter" });
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
    expect(stdout).toContain(`| \`${BUILD}\` | \`bun\`, \`docs-site\`, \`fuzzer\` | public |`);
    expect(stdout).toContain(
      '```diff\n--- .github/workflows/ci.yml\n+++ .github/workflows/ci.yml\n@@\n-name: my own ci\n-on: push\n+name: "Demo Project CI"',
    );
    expect(summary.hold).toBe(true);
    expect(summary.holdReasons).toEqual([
      "local edits replaced in .github/workflows/ci.yml",
      "retirement of .github/workflows/release.yml held: the content differs from the last write",
      "mirror skills/beta/LICENSE.md refused: the target holds content that is not the previous mirror",
      "mirror skills/gamma/LICENSE.md refused: the target holds content that is not the previous mirror",
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
      summary.written.map(() => "unchanged"),
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
