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
import { parse as parseYaml } from "yaml";
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
const droppedMirrorNote = (path: string) =>
  `manifest record for \`${path}\` dropped: no mirror in .repo-platform.yml reaches it now, so ` +
  "the file is the repository's own (a mirror declared again adopts it while it still holds the " +
  "source's content)";

const HASH_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const HASH_END = "# END REPO-PLATFORM MANAGED";
const OLD_REGION = `${HASH_BEGIN}\n# old managed region\nnode_modules/\n${HASH_END}\n`;
/** The .gitignore region the fixture writes for bun up to the END marker: the base, then the module blocks in files.yml order. */
const BUN_REGION_PREFIX =
  `${HASH_BEGIN}\n# Generated from github/gitignore - do not edit between the markers.\n` +
  "node_modules/\n## Node\n*.log\n## Bun\nbun.lockb\n";
const REGION_WITHOUT_FUZZER = `${BUN_REGION_PREFIX}${HASH_END}\n`;
const REGION_WITH_FUZZER = `${BUN_REGION_PREFIX}## Fuzzer\n/.fuzz-failures/\n${HASH_END}\n`;
const OLD_LICENSE = "MIT License\n\nCopyright (c) 2020 Someone\n";
const OLD_CI = "name: platform ci v1\n";
const LOCAL_CI = "name: my own ci\non: push\n";
const OLD_TOOL = "version: 1\n";
const RELEASE_EDITED = "name: release (hand tuned)\n";
const OLD_SECURITY = "# Security policy (old home)\n";
const HTML_BEGIN = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
const HTML_END = "<!-- END REPO-PLATFORM MANAGED -->";
const OLD_CONTRIBUTING_REGION = `${HTML_BEGIN}\n# old contributing guide\n${HTML_END}\n`;
// A repository-owned head and tail around the region: a blank line on each side of it, a CRLF line, and no trailing newline.
const CONTRIBUTING_HEAD = "# Contributing\n\n";
const CONTRIBUTING_TAIL = "\nHouse rules:\r\n- open a PR";
const STARTER = "name: my fuzz\non: workflow_dispatch\n";
const OLD_STARTER = "name: an old starter, still mine\n";
const OLD_NOTES = "# Notes (old home)\n";
const OLD_EDITORCONFIG = "root = true\nindent_style = space\n";
const OLD_GITATTRIBUTES = "* text=auto eol=lf\n";
const OLD_YAMLLINT = "rules: {}\n";
const LOCAL_CONSTRUCTOR = "local notes\n";
const LOCAL_DOCKERIGNORE = "dist/\n";
const UNHASHED = "# unhashed notes\n";
const NEW_LICENSE = `MIT License\n\nCopyright (c) ${YEAR} OwnerOrg\n`;
// The repository's overlay: identity keys, a ruleset of its own, comment
// lines, a CRLF line, and no trailing newline, so the starter's hands-off
// rule is checked byte for byte.
const OWN_OVERLAY = [
  "---",
  "# Demo's OWN settings, applied by OwnerOrg/repo-platform",
  "repository:",
  "  description: A demo repository\r",
  '  homepage: ""',
  "  topics: demo",
  "  private: false",
  "",
  "# The build ref is append-only.",
  "rulesets:",
  "  - name: build-branches",
  "    target: branch",
  "    enforcement: active",
  "    rules:",
  "      - type: deletion",
  "    bypass_actors: []",
].join("\n");
const SETTINGS = ".github/settings.yml";
const HOOK = ".github/actions/site-build/action.yml";
const OWN_HOOK = "name: my own site build\r\nruns: {using: composite, steps: []}";
const OVERLAY = ".github/settings.local.yml";

function oldManifest(): string {
  const entries: Record<string, string> = {
    ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha256(OLD_CI)}"}`,
    "LICENSE.md": `{"class": "managed", "hash": "${sha256(OLD_LICENSE)}"}`,
    ".gitignore": `{"class": "split", "grammar": "managed-region", "begin": "${HASH_BEGIN}", "end": "${HASH_END}", "hash": "${sha256(OLD_REGION)}"}`,
    ".github/old-tool.yml": `{"class": "managed", "hash": "${sha256(OLD_TOOL)}"}`,
    ".github/workflows/release.yml": `{"class": "managed", "hash": "${sha256("name: release\n")}"}`,
    "SECURITY.md": `{"class": "managed", "hash": "${sha256(OLD_SECURITY)}"}`,
    "OLD_NOTES.md": `{"class": "managed", "hash": "${sha256(OLD_NOTES)}"}`,
    "CONTRIBUTING.md": `{"class": "split", "grammar": "managed-region", "begin": "${HTML_BEGIN}", "end": "${HTML_END}", "hash": "${sha256(OLD_CONTRIBUTING_REGION)}"}`,
    ".github/workflows/nightly-fuzz.yml": `{"class": "starter"}`,
    [OVERLAY]: `{"class": "starter"}`,
    ".github/workflows/old-starter.yml": `{"class": "starter"}`,
    ".github/workflows/deselected-starter.yml": `{"class": "starter"}`,
    "skills/gamma/LICENSE.md": `{"class": "mirror", "hash": "${sha256(OLD_LICENSE)}"}`,
    // A mirror record no declaration reaches any more: dropped with a note.
    "docs/old-mirror.md": `{"class": "mirror", "hash": "${sha256(OLD_LICENSE)}"}`,
    // A mirror record under a directory that is now a symlink loop: the
    // record is noted, never looked up through the loop.
    "other/loop/sub/x.md": `{"class": "mirror", "hash": "${sha256(OLD_LICENSE)}"}`,
    // Two link records: one still selected, one no entry writes any more.
    "CLAUDE.md": `{"class": "link", "hash": "${sha256("AGENTS.md")}"}`,
    ".github/copilot-instructions.md": `{"class": "link", "hash": "${sha256("../AGENTS.md")}"}`,
    // Two managed records whose entries are split now: one still the
    // recorded content, one edited since.
    ".editorconfig": `{"class": "managed", "hash": "${sha256(OLD_EDITORCONFIG)}"}`,
    ".gitattributes": `{"class": "managed", "hash": "${sha256("* text=auto\n")}"}`,
    // A managed record without a hash: the flip to split cannot be verified
    // against it, so the file is held and the record carried as it is.
    ".yamllint": `{"class": "managed", "hash": null}`,
    // A starter flipping to managed is held; its path is named like an
    // inherited object property to keep every record lookup honest.
    constructor: `{"class": "starter"}`,
    // A hash-less managed record for a path nothing selects or retires: held
    // every run, its record carried, never a silent orphan.
    "UNHASHED.md": `{"class": "managed", "hash": null}`,
    // A class the writer does not record: the record is dropped with a note.
    "BESPOKE.md": `{"class": "bespoke", "hash": "${sha256("b\n")}"}`,
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
      "modules: [bun, deno, docs-site, fuzzer, uv]",
      "project: {name: Demo Project, slug: demo, description: A demo repository}",
      "labels: {fuzzer: fuzz-me}",
      "mirrors:",
      // A literal in a new directory a glob then matches; a directory at a
      // target and a file where a directory must be, both replaced for review.
      "  - {source: LICENSE.md, targets: [skills/*/LICENSE.md, skills/new/LICENSE.md, plain, skills/alpha/README.md/LICENSE.md]}",
      "  - {source: AGENTS.md, targets: [skills/*/AGENTS.md]}",
      // Links to the source: one over a hand-written file, one into an existing directory.
      "  - {source: LICENSE.md, kind: symlink, targets: [template/LICENSE.md, docs/LICENSE.md]}",
      "",
    ].join("\n"),
    ".github/workflows/ci.yml": LOCAL_CI,
    "LICENSE.md": OLD_LICENSE,
    ".gitignore": `# my ignores above\n${OLD_REGION}# my ignores below\n.idea/\n`,
    ".github/old-tool.yml": OLD_TOOL,
    ".github/workflows/release.yml": RELEASE_EDITED,
    "SECURITY.md": OLD_SECURITY,
    "OLD_NOTES.md": OLD_NOTES,
    "CONTRIBUTING.md": `${CONTRIBUTING_HEAD}${OLD_CONTRIBUTING_REGION}${CONTRIBUTING_TAIL}`,
    ".github/workflows/nightly-fuzz.yml": STARTER,
    [OVERLAY]: OWN_OVERLAY,
    ".github/workflows/old-starter.yml": OLD_STARTER,
    ".github/workflows/deselected-starter.yml": OLD_STARTER,
    "skills/alpha/README.md": "alpha\n",
    "skills/beta/README.md": "beta\n",
    "skills/beta/LICENSE.md": "a hand-written license\n",
    "skills/gamma/README.md": "gamma\n",
    "skills/gamma/LICENSE.md": "an edited mirror copy\n",
    // Holds exactly what the mirror writes, with no record: adopted as current.
    "skills/delta/README.md": "delta\n",
    "skills/delta/LICENSE.md": NEW_LICENSE,
    "docs/old-mirror.md": OLD_LICENSE,
    "template/LICENSE.md": "a hand-written license\n",
    "plain/keep.md": "keep\n",
    "other/keep.md": "",
    ".editorconfig": OLD_EDITORCONFIG,
    ".gitattributes": OLD_GITATTRIBUTES,
    ".yamllint": OLD_YAMLLINT,
    constructor: LOCAL_CONSTRUCTOR,
    ".dockerignore": LOCAL_DOCKERIGNORE,
    "UNHASHED.md": UNHASHED,
    "BESPOKE.md": "b\n",
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
  symlinkSync("loop", join(target, "other/loop"));
  fixtureGit(target, ["init", "-q", "-b", "main"]);
  fixtureGit(target, ["add", "-A"]);
  fixtureGit(target, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "seed"]);
  return target;
}

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

function spawnSync(target: string, summaryPath: string, build = BUILD) {
  return boundedSpawnSync(
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
      build,
      "--repository",
      "OwnerOrg/demo",
      "--private",
      "false",
      "--summary",
      summaryPath,
    ],
    { cwd: REPO_ROOT, env: fixtureGitEnv(), timeoutMs: 60_000 },
  );
}

function runSync(target: string, summaryPath: string): { stdout: string; summary: Summary } {
  const result = spawnSync(target, summaryPath);
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
    expect(summary.modules).toEqual(["bun", "deno", "docs-site", "fuzzer"]);
    expect(summary.notes).toEqual([
      "dropped unknown module `uv` (files.yml does not know it)",
      "manifest record for `BESPOKE.md` dropped: its class or shape is not one the writer records",
      "manifest record for `../escape.txt` ignored: the path carries an empty, '.', or '..' segment",
      droppedMirrorNote("docs/old-mirror.md"),
      droppedMirrorNote("other/loop/sub/x.md"),
    ]);
    expect(read("BESPOKE.md")).toBe("b\n");
    expect(read("docs/old-mirror.md")).toBe(OLD_LICENSE);
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
      row(HOOK, "starter", "created"),
      row(OVERLAY, "starter", "unchanged"),
      row(SETTINGS, "managed", "created"),
      row(".editorconfig", "split", "updated"),
      row(
        ".gitattributes",
        "split",
        "held",
        "class changed from managed to split, and the content differs from the last write",
      ),
      row(
        ".yamllint",
        "split",
        "held",
        "class changed from managed to split, and the record carries no hash",
      ),
      row(
        "constructor",
        "managed",
        "held",
        "class changed from starter to managed, and a starter is repo-owned",
      ),
      row(".dockerignore", "split", "region added"),
      row(".github/workflows/docs-site.yml", "managed", "created"),
      row(".github/workflows/nightly-fuzz.yml", "starter", "unchanged"),
    ]);
    expect(existsSync(join(target, ".github/workflows/private-only.yml"))).toBe(false);
  });

  test("a class flip replaces the recorded content whole and holds anything else", () => {
    // .editorconfig was exactly its managed record: the region alone now, mode kept.
    expect(read(".editorconfig")).toBe(`${HASH_BEGIN}\nroot = true\n${HASH_END}\n`);
    expect(lstatSync(join(target, ".editorconfig")).mode & 0o111).toBe(0o111);
    // .gitattributes was edited since its record: untouched, no region prepended.
    expect(read(".gitattributes")).toBe(OLD_GITATTRIBUTES);
    // .yamllint's record had no hash: the flip cannot be verified, so it is held untouched.
    expect(read(".yamllint")).toBe(OLD_YAMLLINT);
    expect(read("constructor")).toBe(LOCAL_CONSTRUCTOR);
    // An unrecorded, marker-less file selected as split gets the region above it, for review.
    expect(read(".dockerignore")).toBe(
      `${HASH_BEGIN}\nnode_modules\n${HASH_END}\n${LOCAL_DOCKERIGNORE}`,
    );
  });

  test("the render folds the repository's overlay with the layers and leaves it untouched", () => {
    expect(readFileSync(join(target, OVERLAY), "latin1")).toBe(OWN_OVERLAY);
    const text = read(SETTINGS);
    expect(text.split("\n").slice(0, 3)).toEqual([
      "# Generated by repo-platform - do not edit.",
      `# Rendered by the sync from the fleet settings layers, this repository's module selection (.repo-platform.yml), and ${OVERLAY}. Edit that file or the registration; the next sync re-renders this one.`,
      "# Applied by OwnerOrg/repo-platform's settings run.",
    ]);
    const doc = parseYaml(text) as {
      repository: Record<string, unknown>;
      labels: { name: string; color: string; description: string }[];
      rulesets: (Record<string, unknown> & {
        name: string;
        rules?: (Record<string, unknown> & { type: string })[];
      })[];
    };
    // The overlay's identity keys over the baseline, the override on top.
    expect(doc.repository).toEqual({
      has_wiki: false,
      description: "A demo repository",
      homepage: "",
      topics: "demo",
      private: false,
      allow_merge_commit: false,
    });
    // Baseline labels, the bun layer's, then the tracking label with the
    // registration's name and the fuzzer module's tuple.
    expect(doc.labels).toEqual([
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "dependencies", color: "0366d6", description: "Dependency updates" },
      {
        name: "javascript",
        color: "168700",
        description: "Pull requests that update javascript code",
      },
      { name: "fuzz-me", color: "B60205", description: "Automated nightly fuzz failure" },
    ]);
    expect(doc.rulesets.map((r) => r.name)).toEqual(["pr-title", "main", "build-branches"]);
    // The baseline's disabled ruleset and the seed's own ride through whole.
    expect(doc.rulesets[0]).toEqual({
      name: "pr-title",
      target: "branch",
      enforcement: "disabled",
      rules: [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "pr-title", integration_id: 15368 }] },
        },
      ],
    });
    expect(doc.rulesets[2]).toEqual({
      name: "build-branches",
      target: "branch",
      enforcement: "active",
      rules: [{ type: "deletion" }],
      bypass_actors: [],
    });
    expect(doc.rulesets[1]?.rules?.map((r) => r.type)).toEqual([
      "code_quality",
      "deletion",
      "required_status_checks",
    ]);
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
        '  - package-ecosystem: "deno"',
        '    directory: "/"',
        "# end of updates",
        "",
      ].join("\n"),
    );
    expect(read(".github/workflows/checks.yml")).toBe(
      "name: checks\non: pull_request\njobs: {}\n# A demo repository\n# Examples:\n#   bun test\n",
    );
    // The hook starter, absent from the seed, is rendered once and recorded.
    expect(read(HOOK)).toBe("name: site build for demo\nruns: {using: composite, steps: []}\n");
  });

  test("substitutes placeholders and leaves Actions expressions alone", () => {
    expect(read(".github/workflows/ci.yml")).toContain('name: "Demo Project CI"');
    expect(read(".github/workflows/ci.yml")).toContain('"${{ github.sha }} for ownerorg/demo"');
    // The registration's label wins over the module default.
    expect(read(".github/workflows/ci.yml")).toContain('echo "tracking fuzz-me"');
    expect(read("LICENSE.md")).toBe(NEW_LICENSE);
    expect(read("AGENTS.md")).toBe(
      "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Demo Project\n\nA demo repository\n<!-- END REPO-PLATFORM MANAGED -->\n",
    );
    expect(read(".github/workflows/docs-site.yml")).toContain("docs site (standalone)");
  });

  test("rewrites the split region between the repo-owned halves with the module blocks, one Node block for two modules, the fuzzer block last", () => {
    expect(read(".gitignore")).toBe(
      `# my ignores above\n${REGION_WITH_FUZZER}# my ignores below\n.idea/\n`,
    );
  });

  test("never touches the existing starters, selected or retired", () => {
    expect(read(".github/workflows/nightly-fuzz.yml")).toBe(STARTER);
    expect(read(".github/workflows/old-starter.yml")).toBe(OLD_STARTER);
  });

  test("retires: deletes the clean file, holds the edited one, moves the relocated one", () => {
    expect(summary.retired).toEqual([
      { path: ".github/old-tool.yml", outcome: "deleted", detail: "retired" },
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
        path: "CONTRIBUTING.md",
        outcome: "region removed",
        detail:
          "retired; repository-owned content kept as a plain file; the region is gone, so read the file whole, give it a heading and intro if it lost them, or delete it",
      },
      {
        path: ".github/copilot-instructions.md",
        outcome: "deleted",
        detail: "no longer selected",
      },
      { path: "UNHASHED.md", outcome: "held", detail: "the record carries no hash" },
    ]);
    expect(read("UNHASHED.md")).toBe(UNHASHED);
    expect(summary.retired.map((row) => row.path)).not.toContain("CLAUDE.md");
    expect(existsSync(join(target, ".github/old-tool.yml"))).toBe(false);
    // The destination is gated on an unselected module: nothing moves there.
    expect(existsSync(join(target, "OLD_NOTES.md"))).toBe(false);
    expect(existsSync(join(target, "docs/NOTES.md"))).toBe(false);
    expect(read(".github/workflows/release.yml")).toBe(RELEASE_EDITED);
    expect(existsSync(join(target, "SECURITY.md"))).toBe(false);
    expect(read(".github/SECURITY.md")).toContain("Report issues to OwnerOrg privately.");
    // The handover: markers and region gone, the blank lines that framed it merged into one.
    expect(readFileSync(join(target, "CONTRIBUTING.md"))).toEqual(
      Buffer.from("# Contributing\n\nHouse rules:\r\n- open a PR", "utf-8"),
    );
  });

  test("mirrors the written files, literals before globs, replacing what stands at a target", () => {
    const mirror = (source: string, path: string, outcome: string, detail = "") => ({
      source,
      target: path,
      outcome,
      detail,
    });
    // Rows follow the declarations, literals first.
    expect(summary.mirrors).toEqual([
      mirror("LICENSE.md", "skills/new/LICENSE.md", "written"),
      mirror("LICENSE.md", "plain", "replaced", "a directory stood at the target"),
      mirror(
        "LICENSE.md",
        "skills/alpha/README.md/LICENSE.md",
        "replaced",
        "a file stood at ancestor 'skills/alpha/README.md'",
      ),
      mirror("LICENSE.md", "template/LICENSE.md", "replaced local edits"),
      mirror("LICENSE.md", "docs/LICENSE.md", "written"),
      mirror("LICENSE.md", "skills/alpha/LICENSE.md", "written"),
      mirror("LICENSE.md", "skills/beta/LICENSE.md", "replaced local edits"),
      mirror("LICENSE.md", "skills/delta/LICENSE.md", "current"),
      mirror("LICENSE.md", "skills/gamma/LICENSE.md", "replaced local edits"),
      mirror("LICENSE.md", "skills/new/LICENSE.md", "current"),
      mirror("AGENTS.md", "skills/alpha/AGENTS.md", "written"),
      mirror("AGENTS.md", "skills/beta/AGENTS.md", "written"),
      mirror("AGENTS.md", "skills/delta/AGENTS.md", "written"),
      mirror("AGENTS.md", "skills/gamma/AGENTS.md", "written"),
      mirror("AGENTS.md", "skills/new/AGENTS.md", "written"),
    ]);
    // The directory and the blocking file are gone; every target holds the source.
    expect(existsSync(join(target, "plain/keep.md"))).toBe(false);
    expect(read("plain")).toBe(NEW_LICENSE);
    expect(read("skills/alpha/README.md/LICENSE.md")).toBe(NEW_LICENSE);
    expect(read("skills/new/AGENTS.md")).toBe(read("AGENTS.md"));
    for (const skill of ["alpha", "beta", "delta", "gamma", "new"]) {
      expect(read(`skills/${skill}/LICENSE.md`)).toBe(NEW_LICENSE);
    }
    for (const path of ["template/LICENSE.md", "docs/LICENSE.md"]) {
      expect(readlinkSync(join(target, path))).toBe("../LICENSE.md");
      expect(read(path)).toBe(NEW_LICENSE);
    }
    // The retired path was moved, never rewritten by its mirror.
    expect(existsSync(join(target, "SECURITY.md"))).toBe(false);
  });

  test("records what it wrote in the manifest, the build on the self entry", () => {
    const manifest = JSON.parse(read(MANIFEST)) as {
      files: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(manifest.files).sort()).toEqual(
      [
        MANIFEST,
        SETTINGS,
        OVERLAY,
        ".github/workflows/ci.yml",
        "LICENSE.md",
        ".github/SECURITY.md",
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        ".github/agents.md",
        ".github/dependabot.yml",
        ".github/workflows/checks.yml",
        HOOK,
        ".editorconfig",
        ".gitattributes",
        ".yamllint",
        "constructor",
        "UNHASHED.md",
        ".dockerignore",
        "skills/new/LICENSE.md",
        "skills/alpha/AGENTS.md",
        "skills/beta/AGENTS.md",
        "skills/delta/AGENTS.md",
        "skills/gamma/AGENTS.md",
        "skills/new/AGENTS.md",
        "skills/delta/LICENSE.md",
        "skills/beta/LICENSE.md",
        "plain",
        "skills/alpha/README.md/LICENSE.md",
        ".github/workflows/docs-site.yml",
        ".github/workflows/nightly-fuzz.yml",
        ".github/workflows/old-starter.yml",
        ".github/workflows/deselected-starter.yml",
        ".github/workflows/release.yml",
        "skills/alpha/LICENSE.md",
        "skills/gamma/LICENSE.md",
        "template/LICENSE.md",
        "docs/LICENSE.md",
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
    // A current copy with no record is adopted: recorded like a written one.
    expect(manifest.files["skills/delta/LICENSE.md"]).toEqual({
      class: "mirror",
      hash: sha256(NEW_LICENSE),
    });
    expect(manifest.files["docs/old-mirror.md"]).toBeUndefined();
    expect(manifest.files[".github/workflows/nightly-fuzz.yml"]).toEqual({ class: "starter" });
    expect(manifest.files[HOOK]).toEqual({ class: "starter" });
    expect(manifest.files[OVERLAY]).toEqual({ class: "starter" });
    expect(manifest.files[SETTINGS]).toEqual({ class: "managed", hash: sha256(read(SETTINGS)) });
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
    expect(manifest.files["UNHASHED.md"]).toEqual({ class: "managed", hash: null });
    expect(manifest.files[".yamllint"]).toEqual({ class: "managed", hash: null });
    expect(manifest.files[".editorconfig"]).toMatchObject({
      class: "split",
      hash: sha256(read(".editorconfig")),
    });
    // Kept files keep their previous records, so a later sync can still
    // recognise the platform's last write.
    expect(manifest.files[".github/workflows/old-starter.yml"]).toEqual({ class: "starter" });
    expect(manifest.files[".github/workflows/deselected-starter.yml"]).toEqual({
      class: "starter",
    });
    expect(read(".github/workflows/deselected-starter.yml")).toBe(OLD_STARTER);
    expect(manifest.files["docs/NOTES.md"]).toBeUndefined();
    // The handed-over split file's record left with its region.
    expect(manifest.files["CONTRIBUTING.md"]).toBeUndefined();
    // Every mirror target is recorded with the copy's hash, the replaced ones too.
    for (const path of ["skills/gamma/LICENSE.md", "skills/beta/LICENSE.md", "plain"]) {
      expect(manifest.files[path]).toEqual({ class: "mirror", hash: sha256(NEW_LICENSE) });
    }
    for (const path of ["template/LICENSE.md", "docs/LICENSE.md"]) {
      expect(manifest.files[path]).toEqual({
        class: "mirror",
        kind: "symlink",
        hash: sha256("../LICENSE.md"),
      });
    }
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
      `| \`${BUILD}\` | \`bun\`, \`deno\`, \`docs-site\`, \`fuzzer\` | public |`,
    );
    expect(stdout).toContain(
      "| `.gitattributes` | split | held | class changed from managed to split, and the content differs from the last write |",
    );
    expect(stdout).toContain(
      '```diff\n--- .github/workflows/ci.yml\n+++ .github/workflows/ci.yml\n@@\n-name: my own ci\n-on: push\n+name: "Demo Project CI"',
    );
    expect(stdout).toContain(
      "#### `skills/beta/LICENSE.md`\n\n```diff\n--- skills/beta/LICENSE.md\n+++ skills/beta/LICENSE.md\n@@\n-a hand-written license\n+MIT License",
    );
    expect(summary.hold).toBe(true);
    expect(summary.holdReasons).toEqual([
      ".gitattributes held: class changed from managed to split, and the content differs from the last write",
      ".yamllint held: class changed from managed to split, and the record carries no hash",
      "constructor held: class changed from starter to managed, and a starter is repo-owned",
      ".dockerignore: the managed region was added above repository-owned content",
      "local edits replaced in .github/workflows/ci.yml",
      "local edits replaced in template/LICENSE.md",
      "local edits replaced in skills/beta/LICENSE.md",
      "local edits replaced in skills/gamma/LICENSE.md",
      "retirement of .github/workflows/release.yml held: the content differs from the last write",
      "retirement of CONTRIBUTING.md: the managed region was removed and the repository-owned content kept",
      "retirement of UNHASHED.md held: the record carries no hash",
      "mirror plain replaced: a directory stood at the target",
      "mirror skills/alpha/README.md/LICENSE.md replaced: a file stood at ancestor 'skills/alpha/README.md'",
      "registration: dropped unknown module `uv` (files.yml does not know it)",
      "registration: manifest record for `BESPOKE.md` dropped: its class or shape is not one the writer records",
      "registration: manifest record for `../escape.txt` ignored: the path carries an empty, '.', or '..' segment",
      `registration: ${droppedMirrorNote("docs/old-mirror.md")}`,
      `registration: ${droppedMirrorNote("other/loop/sub/x.md")}`,
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
      { path: "UNHASHED.md", outcome: "held", detail: "the record carries no hash" },
    ]);
    // The region-added file is now a marked split file: current, no longer held.
    expect(again.summary.holdReasons).not.toContainEqual(expect.stringContaining(".dockerignore"));
    // The handed-over split file is the repository's own now: no row, no hold.
    expect(again.summary.holdReasons).not.toContainEqual(
      expect.stringContaining("CONTRIBUTING.md"),
    );
    // The local edits are gone, the replaced mirrors are current, and the
    // unsafe record left the manifest; the other reasons stand until a
    // human acts.
    expect(again.summary.holdReasons).toEqual(
      summary.holdReasons.filter(
        (r) =>
          !r.startsWith("local edits") &&
          !r.startsWith("mirror ") &&
          !r.includes("manifest record") &&
          !r.startsWith(".dockerignore") &&
          !r.startsWith("retirement of CONTRIBUTING.md"),
      ),
    );
    expect(snapshot(target)).toEqual(before);
  });
});

describe("sync.ts over a repository whose settings or overlay path is taken", () => {
  const THEIRS = "# an overlay someone already wrote\nrepository:\n  private: false\n";
  // A document an earlier sync rendered, its manifest record since lost.
  const RENDERED_STALE =
    "# Generated by repo-platform - do not edit.\n# Rendered by the sync\nrepository:\n  description: stale\n";
  const DIRECTORY_HELD = "a directory sits at the path, and the writer will not replace it";
  const row = (path: string, cls: string, change: string, detail = "") => ({
    path,
    class: cls,
    change,
    detail,
  });
  const dirWithInner = (target: string, rel: string) => {
    mkdirSync(join(target, rel), { recursive: true });
    writeFileSync(join(target, rel, "inner.yml"), THEIRS);
  };
  test.each<{
    reason: string;
    seed: (target: string) => void;
    rows: Summary["written"];
    /** The hold reasons about the two settings paths, in report order. */
    holds: string[];
    still: (target: string) => void;
  }>([
    {
      reason: "a directory at the overlay path, no settings.yml",
      seed: (target: string) => dirWithInner(target, OVERLAY),
      rows: [
        row(OVERLAY, "starter", "held", DIRECTORY_HELD),
        row(
          SETTINGS,
          "managed",
          "held",
          `${OVERLAY} is a directory, which the render does not read through`,
        ),
      ],
      holds: [
        `${OVERLAY} held: ${DIRECTORY_HELD}`,
        `${SETTINGS} held: ${OVERLAY} is a directory, which the render does not read through`,
      ],
      still: (target: string) => {
        expect(existsSync(join(target, SETTINGS))).toBe(false);
        expect(readFileSync(join(target, OVERLAY, "inner.yml"), "utf-8")).toBe(THEIRS);
      },
    },
    {
      reason: "a directory at the settings.yml path, no overlay",
      seed: (target: string) => dirWithInner(target, SETTINGS),
      rows: [row(OVERLAY, "starter", "created"), row(SETTINGS, "managed", "held", DIRECTORY_HELD)],
      holds: [`${SETTINGS} held: ${DIRECTORY_HELD}`],
      still: (target: string) => {
        expect(readFileSync(join(target, SETTINGS, "inner.yml"), "utf-8")).toBe(THEIRS);
        expect(existsSync(join(target, OVERLAY))).toBe(true);
      },
    },
    {
      reason: "a rendered settings.yml with no manifest record, the repository's overlay beside it",
      seed: (target: string) => {
        writeFileSync(join(target, SETTINGS), RENDERED_STALE);
        writeFileSync(join(target, OVERLAY), THEIRS);
      },
      rows: [
        row(OVERLAY, "starter", "unchanged"),
        row(SETTINGS, "managed", "replaced local edits"),
      ],
      // No record vouches for its bytes, so the re-render is shown as a
      // replaced edit once, then recorded.
      holds: [`local edits replaced in ${SETTINGS}`],
      still: (target: string) => {
        const text = readFileSync(join(target, SETTINGS), "utf-8");
        expect(text.startsWith("# Generated by repo-platform - do not edit.\n")).toBe(true);
        expect(text).not.toContain("description: stale");
        expect(readFileSync(join(target, OVERLAY), "utf-8")).toBe(THEIRS);
        const manifest = JSON.parse(readFileSync(join(target, MANIFEST), "utf-8")) as {
          files: Record<string, unknown>;
        };
        expect(manifest.files[SETTINGS]).toEqual({ class: "managed", hash: sha256(text) });
      },
    },
  ])("$reason: the sync ends in a report with both rows", ({ seed, rows, holds, still }) => {
    const target = temp.dir("sync-e2e-taken-target-");
    mkdirSync(join(target, ".github"), { recursive: true });
    writeFileSync(
      join(target, ".repo-platform.yml"),
      "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n",
    );
    seed(target);
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const { summary } = runSync(target, join(temp.dir("sync-e2e-taken-summary-"), "summary.json"));
    expect(summary.written.filter((r) => r.path.startsWith(".github/settings"))).toEqual(rows);
    still(target);
    expect(summary.holdReasons.filter((r) => r.includes(".github/settings"))).toEqual(holds);
  });
});

describe("sync.ts over a registration with an empty description", () => {
  test("an entry needing a placeholder with no value is held, noted, and never written empty", () => {
    const target = temp.dir("sync-e2e-bare-target-");
    writeFileSync(
      join(target, ".repo-platform.yml"),
      'modules: [bun, fuzzer]\nproject: {name: Demo, slug: demo, description: ""}\n',
    );
    // Both fixture starters need {{description}}: the present one is the
    // repository's own and is not rendered, the absent one is held. The
    // hook the repository already carries stays byte for byte.
    mkdirSync(join(target, ".github/workflows"), { recursive: true });
    writeFileSync(join(target, ".github/workflows/nightly-fuzz.yml"), STARTER);
    mkdirSync(join(target, ".github/actions/site-build"), { recursive: true });
    writeFileSync(join(target, HOOK), OWN_HOOK);
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const { summary } = runSync(target, join(temp.dir("sync-e2e-bare-summary-"), "summary.json"));
    // An empty description is no value: a placeholder is never written blank.
    const held = (path: string, cls: string) => ({
      path,
      class: cls,
      change: "held",
      detail: "no value for {{description}}",
    });
    expect(summary.written.find((row) => row.path === "AGENTS.md")).toEqual(
      held("AGENTS.md", "split"),
    );
    expect(summary.written.find((row) => row.path === ".github/workflows/checks.yml")).toEqual(
      held(".github/workflows/checks.yml", "starter"),
    );
    expect(
      summary.written.find((row) => row.path === ".github/workflows/nightly-fuzz.yml"),
    ).toEqual({
      path: ".github/workflows/nightly-fuzz.yml",
      class: "starter",
      change: "unchanged",
      detail: "",
    });
    expect(summary.written.find((row) => row.path === HOOK)).toEqual({
      path: HOOK,
      class: "starter",
      change: "unchanged",
      detail: "",
    });
    expect(readFileSync(join(target, HOOK), "latin1")).toBe(OWN_HOOK);
    // The overlay starter needs the description too, so the render finds
    // no overlay and holds behind it.
    expect(summary.written.find((row) => row.path === OVERLAY)).toEqual(held(OVERLAY, "starter"));
    expect(summary.written.find((row) => row.path === SETTINGS)).toEqual({
      path: SETTINGS,
      class: "managed",
      change: "held",
      detail: `no overlay at ${OVERLAY} (its starter is held or missing)`,
    });
    expect(existsSync(join(target, SETTINGS))).toBe(false);
    expect(readFileSync(join(target, ".github/workflows/nightly-fuzz.yml"), "utf-8")).toBe(STARTER);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target, ".github/workflows/checks.yml"))).toBe(false);
    expect(readFileSync(join(target, "LICENSE.md"), "utf-8")).toBe(
      `MIT License\n\nCopyright (c) ${YEAR} OwnerOrg\n`,
    );
    expect(summary.notes).toEqual([
      "placeholder `{{description}}` has no value: set project.description in .repo-platform.yml",
    ]);
    expect(summary.hold).toBe(true);
    expect(summary.holdReasons).toContain(
      "registration: placeholder `{{description}}` has no value: set project.description in .repo-platform.yml",
    );
    const manifest = JSON.parse(readFileSync(join(target, MANIFEST), "utf-8")) as {
      files: Record<string, unknown>;
    };
    expect(manifest.files["AGENTS.md"]).toBeUndefined();
    expect(manifest.files[HOOK]).toEqual({ class: "starter" });
  });
});

describe("sync.ts over a repository that deselected the fuzzer module", () => {
  test("the recorded region carrying the fuzzer block is rewritten without it, the repo-owned sides untouched", () => {
    const target = temp.dir("sync-e2e-no-fuzzer-target-");
    const files: Record<string, string> = {
      ".repo-platform.yml":
        "modules: [bun]\nproject: {name: Demo Project, slug: demo, description: A demo repository}\n",
      ".gitignore": `# my ignores above\n${REGION_WITH_FUZZER}# my ignores below\n`,
      [MANIFEST]: `{"files": {".gitignore": {"class": "split", "grammar": "managed-region", "begin": "${HASH_BEGIN}", "end": "${HASH_END}", "hash": "${sha256(REGION_WITH_FUZZER)}"}}}\n`,
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(target, rel)), { recursive: true });
      writeFileSync(join(target, rel), content);
    }
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const { summary } = runSync(
      target,
      join(temp.dir("sync-e2e-no-fuzzer-summary-"), "summary.json"),
    );
    expect(summary.modules).toEqual(["bun"]);
    expect(summary.written.find((row) => row.path === ".gitignore")).toEqual({
      path: ".gitignore",
      class: "split",
      change: "updated",
      detail: "",
    });
    expect(readFileSync(join(target, ".gitignore"), "utf-8")).toBe(
      `# my ignores above\n${REGION_WITHOUT_FUZZER}# my ignores below\n`,
    );
    const manifest = JSON.parse(readFileSync(join(target, MANIFEST), "utf-8")) as {
      files: Record<string, unknown>;
    };
    expect(manifest.files[".gitignore"]).toEqual({
      class: "split",
      grammar: "managed-region",
      begin: HASH_BEGIN,
      end: HASH_END,
      hash: sha256(REGION_WITHOUT_FUZZER),
    });
  });
});

describe("sync.ts over a --build that is not the build commit's full sha", () => {
  test.each([
    { reason: "a short sha", build: BUILD.slice(0, 12) },
    { reason: "an uppercase sha", build: BUILD.toUpperCase() },
  ])("$reason is refused at the command line, before anything is written", ({ build }) => {
    const target = temp.dir("sync-e2e-build-target-");
    writeFileSync(
      join(target, ".repo-platform.yml"),
      "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n",
    );
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const summary = join(temp.dir("sync-e2e-build-summary-"), "summary.json");
    expect(spawnSync(target, summary, build)).toEqual({
      exitCode: 1,
      stdout: `::error::--build must be the build commit's full sha (40 lowercase hex characters), got "${build}"\n`,
      stderr: "",
    });
    expect(existsSync(join(target, MANIFEST))).toBe(false);
    expect(existsSync(join(target, "LICENSE.md"))).toBe(false);
    expect(existsSync(summary)).toBe(false);
  });
});

describe("sync.ts over a mirror declaration it cannot write", () => {
  function seed(registration: string, links: Record<string, string> = {}): string {
    const target = temp.dir("sync-e2e-mirror-target-");
    writeFileSync(join(target, ".repo-platform.yml"), registration);
    mkdirSync(join(target, "skills/a"), { recursive: true });
    writeFileSync(join(target, "skills/a/README.md"), "");
    for (const [path, to] of Object.entries(links)) symlinkSync(to, join(target, path));
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    return target;
  }
  const error = (source: string, target: string, problem: string) =>
    `::error::.repo-platform.yml: mirrors: source '${source}', target '${target}': ${problem}`;

  test("an impossible declaration exits nonzero naming every problem, and records nothing", () => {
    const target = seed(
      [
        "modules: [bun]",
        "project: {name: Demo, slug: demo, description: A demo}",
        "mirrors:",
        "  - {source: LICENSE.md, targets: [copies/a, copies/a/b, .github/repo-platform-manifest.json]}",
        "  - {source: README.md, targets: [skills/*/README.md]}",
        "  - {source: LICENSE.md, targets: [SECURITY.md, docs/GONE.md, docs/**/LICENSE.md]}",
        "",
      ].join("\n"),
    );
    // A managed record of a module no longer selected: the run retires it,
    // and no mirror may land there.
    const stale = `{\n  "files": {\n    "docs/GONE.md": {"class": "managed", "hash": "${sha256("gone\n")}"}\n  }\n}\n`;
    mkdirSync(join(target, ".github"));
    writeFileSync(join(target, MANIFEST), stale);
    const result = spawnSync(target, join(temp.dir("sync-e2e-mirror-summary-"), "summary.json"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${[
        error("LICENSE.md", MANIFEST, "the target is a path files.yml writes"),
        error(
          "README.md",
          "skills/*/README.md",
          "the source is not a managed or split file files.yml writes for this repository",
        ),
        error("LICENSE.md", "SECURITY.md", "the target is a path files.yml retires"),
        error("LICENSE.md", "docs/GONE.md", "the target is a path a stale manifest record retires"),
        error("LICENSE.md", "docs/**/LICENSE.md", "the pattern uses '**'"),
        error(
          "LICENSE.md",
          "copies/a",
          "the target is a path prefix of another target 'copies/a/b'",
        ),
        error("LICENSE.md", "copies/a/b", "the target sits under another target 'copies/a'"),
      ].join("\n")}\n`,
    );
    expect(readFileSync(join(target, MANIFEST), "utf-8")).toBe(stale);
    expect(existsSync(join(target, "copies"))).toBe(false);
  });

  test("a symbolic link above a target exits nonzero the same way, and the pass writes over no link it could have replaced", () => {
    const target = seed(
      [
        "modules: [bun]",
        "project: {name: Demo, slug: demo, description: A demo}",
        "mirrors:",
        "  - {source: LICENSE.md, targets: [skills/*/LICENSE.md, linked/LICENSE.md]}",
        "",
      ].join("\n"),
      { "skills/a/LICENSE.md": "../../LICENSE.md", linked: "skills" },
    );
    const result = spawnSync(target, join(temp.dir("sync-e2e-mirror-summary-"), "summary.json"));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      `${error("LICENSE.md", "linked/LICENSE.md", "the target's ancestor 'linked' is a symbolic link")}\n`,
    );
    expect(existsSync(join(target, MANIFEST))).toBe(false);
    expect(readlinkSync(join(target, "skills/a/LICENSE.md"))).toBe("../../LICENSE.md");
  });
});

describe("sync.ts over retired paths whose records the writer cannot read", () => {
  // Hand edits: a mirror kind the writer never writes, a split record without its markers. Each file matches its hash.
  const records: Record<string, string> = {
    ".github/old-tool.yml": `{"class": "mirror", "kind": "hardlink", "hash": "${sha256(OLD_TOOL)}"}`,
    "CONTRIBUTING.md": `{"class": "split", "grammar": "managed-region", "hash": "${sha256(OLD_CONTRIBUTING_REGION)}"}`,
  };
  const dropped = Object.keys(records).map(
    (path) =>
      `manifest record for \`${path}\` dropped: its class or shape is not one the writer records`,
  );

  test("the first run drops each record with a note and holds; the second has nothing to say, both files untouched", () => {
    const target = temp.dir("sync-e2e-unreadable-target-");
    const files: Record<string, string> = {
      ".repo-platform.yml":
        "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n",
      ".github/old-tool.yml": OLD_TOOL,
      "CONTRIBUTING.md": OLD_CONTRIBUTING_REGION,
      [MANIFEST]: `{\n  "files": {\n${Object.entries(records)
        .map(([path, body]) => `    ${JSON.stringify(path)}: ${body}`)
        .join(",\n")}\n  }\n}\n`,
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(target, rel)), { recursive: true });
      writeFileSync(join(target, rel), content);
    }
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const recorded = () =>
      Object.keys(
        (JSON.parse(readFileSync(join(target, MANIFEST), "utf-8")) as { files: object }).files,
      );
    const first = runSync(target, join(temp.dir("sync-e2e-unreadable-summary-"), "summary.json"));
    expect(first.summary.notes).toEqual(dropped);
    expect(first.summary.retired).toEqual([]);
    expect(first.summary.hold).toBe(true);
    expect(recorded()).not.toContain(".github/old-tool.yml");
    expect(recorded()).not.toContain("CONTRIBUTING.md");
    const second = runSync(target, join(temp.dir("sync-e2e-unreadable-summary2-"), "summary.json"));
    expect(second.summary.notes).toEqual([]);
    expect(second.summary.retired).toEqual([]);
    expect(second.summary.hold).toBe(false);
    expect(readFileSync(join(target, ".github/old-tool.yml"), "utf-8")).toBe(OLD_TOOL);
    expect(readFileSync(join(target, "CONTRIBUTING.md"), "utf-8")).toBe(OLD_CONTRIBUTING_REGION);
  });
});

describe("sync.ts over a starter record it cannot read under a linked directory", () => {
  test("the record is dropped with a note and never probed, so the run exits 0", () => {
    const target = temp.dir("sync-e2e-linked-starter-target-");
    writeFileSync(
      join(target, ".repo-platform.yml"),
      "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n",
    );
    mkdirSync(join(target, ".github"));
    writeFileSync(
      join(target, MANIFEST),
      `{\n  "files": {\n    "docs/old.md": {"class": "starter", "hash": null}\n  }\n}\n`,
    );
    symlinkSync("elsewhere", join(target, "docs"));
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const { summary } = runSync(
      target,
      join(temp.dir("sync-e2e-linked-starter-summary-"), "summary.json"),
    );
    expect(summary.notes).toEqual([
      "manifest record for `docs/old.md` dropped: its class or shape is not one the writer records",
    ]);
    const manifest = JSON.parse(readFileSync(join(target, MANIFEST), "utf-8")) as {
      files: Record<string, unknown>;
    };
    expect(manifest.files["docs/old.md"]).toBeUndefined();
    expect(readlinkSync(join(target, "docs"))).toBe("elsewhere");
  });
});
