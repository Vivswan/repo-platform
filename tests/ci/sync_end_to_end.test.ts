import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { sha256 } from "../../actions/shared/values.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";
import { snapshotTree } from "../shared/tree_snapshot";
import { spawnUpstream } from "../shared/upstream_server";

const temp = tempDirs();
// The fixture's github/gitignore, served over loopback: the writer fetches its registered blocks from here, never the network.
const upstream = await spawnUpstream(join(import.meta.dir, "sync_end_to_end/fixtures/upstream"));
afterAll(() => upstream.stop());
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const FIXTURES = join(import.meta.dir, "sync_end_to_end/fixtures");
const BUILD = "abcdef0123456789abcdef0123456789abcdef01";
const MANIFEST = ".github/repo-platform-manifest.json";
const YEAR = String(new Date().getUTCFullYear());

const droppedMirrorNote = (path: string) =>
  `manifest record for \`${path}\` dropped: no mirror in files.yml or .repo-platform.yml reaches it now, so ` +
  "the file is the repository's own (a mirror declared again adopts it while it still holds the " +
  "source's content)";

const HASH_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const HASH_END = "# END REPO-PLATFORM MANAGED";
const OLD_REGION = `${HASH_BEGIN}\n# old managed region\nnode_modules/\n${HASH_END}\n`;
/** The .gitignore region the fixture writes for bun up to the END marker: the base, the three OS blocks every repository
 *  takes, then the module blocks in files.yml order; the upstream bodies arrive normalized (`Icon[\r]`, trailing spaces). */
const BUN_REGION_PREFIX =
  `${HASH_BEGIN}\n# Generated from github/gitignore - do not edit between the markers.\n` +
  "node_modules/\n" +
  "## Windows (github/gitignore Global/Windows.gitignore)\nThumbs.db\n\n" +
  "## macOS (github/gitignore Global/macOS.gitignore)\n.DS_Store\nIcon?\n\n" +
  "## Linux (github/gitignore Global/Linux.gitignore)\n*~\n\n" +
  "## Node (github/gitignore Node.gitignore)\n*.log\n\n" +
  "## Bun (github/gitignore Bun.gitignore)\nbun.lockb\n\n";
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
const HANDMADE = "# my own notes, recorded by hand\n";
const LOCAL_DEPENDABOT = "version: 2\n# my own update schedule\n";
const LOCAL_COPILOT = "# my own copilot notes\n";
const FLEET_LINKS = {
  "CLAUDE.md": "AGENTS.md",
  ".github/agents.md": "../AGENTS.md",
  ".github/copilot-instructions.md": "../AGENTS.md",
};
const noWriterNote = (path: string) =>
  `manifest record for \`${path}\` had no writer: no files.yml entry declares the path now; ` +
  "it is retired as a stale record (the Retired row has the outcome)";
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
  "# Release branches are append-only.",
  "rulesets:",
  "  - name: release-branches",
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
    // Records at paths no files.yml entry declares any more, each a state the stale-record retirement judges: the
    // platform's own last write (deleted), an edit since (held), a split region with repository-owned content around
    // it (region removed), and one whose file is gone (no row, the record leaves).
    ".github/old-tool.yml": `{"class": "managed", "hash": "${sha256(OLD_TOOL)}"}`,
    ".github/workflows/release.yml": `{"class": "managed", "hash": "${sha256("name: release\n")}"}`,
    "SECURITY.md": `{"class": "managed", "hash": "${sha256(OLD_SECURITY)}"}`,
    "OLD_NOTES.md": `{"class": "managed", "hash": "${sha256(OLD_NOTES)}"}`,
    "CONTRIBUTING.md": `{"class": "split", "grammar": "managed-region", "begin": "${HTML_BEGIN}", "end": "${HTML_END}", "hash": "${sha256(OLD_CONTRIBUTING_REGION)}"}`,
    ".github/workflows/nightly-fuzz.yml": `{"class": "starter"}`,
    [OVERLAY]: `{"class": "starter"}`,
    // Starter records of entries nothing selects now: the files are the repository's own, and the records leave.
    ".github/workflows/old-starter.yml": `{"class": "starter"}`,
    ".github/workflows/deselected-starter.yml": `{"class": "starter"}`,
    "skills/gamma/LICENSE.md": `{"class": "mirror", "hash": "${sha256(OLD_LICENSE)}"}`,
    // A mirror record no declaration reaches any more: dropped with a note.
    "docs/old-mirror.md": `{"class": "mirror", "hash": "${sha256(OLD_LICENSE)}"}`,
    // A mirror record under a directory that is now a symlink loop: the
    // record is noted, never looked up through the loop.
    "other/loop/sub/x.md": `{"class": "mirror", "hash": "${sha256(OLD_LICENSE)}"}`,
    // The fleet's symlink, recorded and standing: current.
    "CLAUDE.md": `{"class": "mirror", "kind": "symlink", "hash": "${sha256("AGENTS.md")}"}`,
    // Two managed records whose entries are split now: one still the
    // recorded content, one edited since.
    ".editorconfig": `{"class": "managed", "hash": "${sha256(OLD_EDITORCONFIG)}"}`,
    ".gitattributes": `{"class": "managed", "hash": "${sha256("* text=auto\n")}"}`,
    // A managed record whose hash the file no longer matches: nothing vouches
    // for the content, so the flip to split treats the file as unrecorded.
    ".yamllint": `{"class": "managed", "hash": "${sha256("rules: {other: enable}\n")}"}`,
    // A starter record on a managed path is stale, and the file is replaced
    // like any local edit; the path is named like an inherited object
    // property to keep every record lookup honest.
    constructor: `{"class": "starter"}`,
    "../escape.txt": `{"class": "managed", "hash": "${sha256("x")}"}`,
    // A hand-added record with the file's true hash, at a path no files.yml
    // entry declares: retired as stale, and noted because no current files.yml
    // entry declares the path.
    "HANDMADE.md": `{"class": "managed", "hash": "${sha256(HANDMADE)}"}`,
    // The same with nothing at the path: nothing to review, so no note; the
    // record leaves the manifest like any other stale record of an absent file.
    "HANDMADE-GONE.md": `{"class": "managed", "hash": "${sha256(HANDMADE)}"}`,
    // A self entry from before the commit field: this sync stamps the build.
    [MANIFEST]: '{"class": "managed", "hash": null}',
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
      // Shuffled on purpose: the selection comes out in files.yml order, never the registration's.
      "modules: [fuzzer, bun, docs-site, deno]",
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
    "HANDMADE.md": HANDMADE,
    ".github/dependabot.yml": LOCAL_DEPENDABOT,
    // A hand-written file where the fleet's symlink lands: replaced, its text shown.
    ".github/copilot-instructions.md": LOCAL_COPILOT,
    [MANIFEST]: oldManifest(),
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), content);
  }
  // An executable whose class flips must keep its mode.
  chmodSync(join(target, ".editorconfig"), 0o755);
  symlinkSync("AGENTS.md", join(target, "CLAUDE.md"));
  symlinkSync("loop", join(target, "other/loop"));
  fixtureGit(target, ["init", "-q", "-b", "main"]);
  fixtureGit(target, ["add", "-A"]);
  fixtureGit(target, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "seed"]);
  return target;
}

interface Summary {
  hold: boolean;
  holdReasons: string[];
  modules: string[];
  written: { path: string; class: string; change: string; detail: string }[];
  retired: { path: string; outcome: string; detail: string }[];
  mirrors: { source: string; target: string; outcome: string; detail: string }[];
  notes: string[];
}

function spawnSync(target: string, summaryPath: string, build = BUILD, extra: string[] = []) {
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
      "--upstream",
      upstream.host,
      ...extra,
    ],
    { cwd: REPO_ROOT, env: fixtureGitEnv(), timeoutMs: 60_000 },
  );
}

function runSync(
  target: string,
  summaryPath: string,
  build = BUILD,
): { stdout: string; summary: Summary } {
  const result = spawnSync(target, summaryPath, build);
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
    seeded = snapshotTree(target);
    ({ stdout, summary } = runSync(target, join(temp.dir("sync-e2e-summary-"), "summary.json")));
  });

  test("selects the modules in files.yml order; stale records with a file present, unsafe paths, and unreached mirrors become notes", () => {
    // The notes list is assembled in sync.ts from four rules and is the only home of three of the messages; a
    // stale record believed instead of noted let a hand edit through without a hold (#243).
    expect(summary.modules).toEqual(["bun", "deno", "docs-site", "fuzzer"]);
    expect(summary.notes).toEqual([
      noWriterNote(".github/old-tool.yml"),
      noWriterNote(".github/workflows/release.yml"),
      noWriterNote("SECURITY.md"),
      noWriterNote("OLD_NOTES.md"),
      noWriterNote("CONTRIBUTING.md"),
      "manifest record for `../escape.txt` ignored: the path carries an empty, '.', or '..' segment",
      noWriterNote("HANDMADE.md"),
      droppedMirrorNote("docs/old-mirror.md"),
      droppedMirrorNote("other/loop/sub/x.md"),
    ]);
    expect(read("docs/old-mirror.md")).toBe(OLD_LICENSE);
  });

  test("writes each class with the right change verdict", () => {
    // The run's own table across every class writer: the files.yml order and the flip details exist only here.
    const row = (path: string, cls: string, change: string, detail = "") => ({
      path,
      class: cls,
      change,
      detail,
    });
    expect(summary.written).toEqual([
      row(".github/workflows/ci.yml", "managed", "replaced local edits"),
      row("LICENSE.md", "managed", "updated"),
      row(".github/SECURITY.md", "managed", "created"),
      row(".gitignore", "split", "updated"),
      row("AGENTS.md", "split", "created"),
      row(".github/dependabot.yml", "managed", "replaced local edits"),
      row(".github/workflows/checks.yml", "starter", "created"),
      row(HOOK, "starter", "created"),
      row(OVERLAY, "starter", "unchanged"),
      row(SETTINGS, "managed", "created"),
      row(".editorconfig", "split", "updated"),
      row(
        ".gitattributes",
        "split",
        "region added",
        "class changed from managed to split; the record was stale, so the file was judged unrecorded",
      ),
      row(
        ".yamllint",
        "split",
        "region added",
        "class changed from managed to split; the record was stale, so the file was judged unrecorded",
      ),
      row(
        "constructor",
        "managed",
        "replaced local edits",
        "class changed from starter to managed; the record was stale, so the file was judged unrecorded",
      ),
      row(".dockerignore", "split", "region added"),
      row(".github/workflows/docs-site.yml", "managed", "created"),
      row(".github/workflows/nightly-fuzz.yml", "starter", "unchanged"),
    ]);
    expect(existsSync(join(target, ".github/workflows/private-only.yml"))).toBe(false);
  });

  test("a class flip replaces the recorded content whole and writes anything else as unrecorded", () => {
    // writeEntry's flip rule has no unit test: a stale record read as the platform's own write would overwrite
    // a hand-edited file with no diff shown.
    // .editorconfig was exactly its managed record: the region alone now, mode kept.
    expect(read(".editorconfig")).toBe(`${HASH_BEGIN}\nroot = true\n${HASH_END}\n`);
    expect(lstatSync(join(target, ".editorconfig")).mode & 0o111).toBe(0o111);
    // .gitattributes and .yamllint were edited since their records: neither
    // is the platform's own write, so each gets the region above its content
    // like any unrecorded file.
    expect(read(".gitattributes")).toBe(
      `${HASH_BEGIN}\n* text=auto\n${HASH_END}\n${OLD_GITATTRIBUTES}`,
    );
    expect(read(".yamllint")).toBe(`${HASH_BEGIN}\nextends: default\n${HASH_END}\n${OLD_YAMLLINT}`);
    expect(read("constructor")).toBe("platform notes\n");
    // The report's diff is fed the bytes the writer replaced, not a re-read.
    expect(stdout).toContain(
      "#### `constructor`\n\n```diff\n--- constructor\n+++ constructor\n@@\n-local notes\n+platform notes",
    );
    // An unrecorded, marker-less file selected as split gets the region above it, for review.
    expect(read(".dockerignore")).toBe(
      `${HASH_BEGIN}\nnode_modules\n${HASH_END}\n${LOCAL_DOCKERIGNORE}`,
    );
  });

  test("the render folds the repository's overlay with the layers and leaves it untouched", () => {
    // The starter's hands-off rule against a real CRLF file with no trailing newline. The registration's tracking
    // label reaches the rendered settings through the fuzzer module here; settings_entry.test feeds it by hand.
    expect(readFileSync(join(target, OVERLAY), "latin1")).toBe(OWN_OVERLAY);
    const doc = parseYaml(read(SETTINGS)) as {
      repository: Record<string, unknown>;
      labels: {
        _undeclared: string;
        entries: { name: string; color: string; description: string }[];
      };
      rulesets: { _undeclared: string };
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
    // Baseline labels, the bun layer's, and the tracking label with the
    // registration's name and the fuzzer module's tuple, sorted by name.
    expect(doc.labels).toEqual({
      entries: [
        { name: "bug", color: "d73a4a", description: "Something isn't working" },
        { name: "dependencies", color: "0366d6", description: "Dependency updates" },
        { name: "fuzz-me", color: "B60205", description: "Automated nightly fuzz failure" },
        {
          name: "javascript",
          color: "168700",
          description: "Pull requests that update javascript code",
        },
      ],
      _undeclared: "delete",
    });
    // The override's policy, not the library's default of keep.
    expect(doc.rulesets._undeclared).toBe("delete");
  });

  test.each<[string, string | string[]]>([
    [
      ".github/dependabot.yml",
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
    ],
    [
      ".github/workflows/checks.yml",
      "name: checks\non: pull_request\njobs: {}\n# A demo repository\n# Examples:\n#   bun test\n",
    ],
    [HOOK, "name: site build for demo\nruns: {using: composite, steps: []}\n"],
    [".gitignore", `# my ignores above\n${REGION_WITH_FUZZER}# my ignores below\n.idea/\n`],
    ["LICENSE.md", NEW_LICENSE],
    ["AGENTS.md", `${HTML_BEGIN}\n# Demo Project\n\nA demo repository\n${HTML_END}\n`],
    [
      ".github/workflows/ci.yml",
      [
        'name: "Demo Project CI"',
        '"${{ github.sha }} for ownerorg/demo"',
        // The registration's label wins over the module default.
        'echo "tracking fuzz-me"',
      ],
    ],
    [".github/workflows/docs-site.yml", ["docs site (standalone)"]],
  ])("renders %s from its entry, its blocks, and the registration", (path, expected) => {
    // Each rule has a unit home (placeholders, write_split, write_classes, files_config); the whole file each
    // rule contributes to is assembled only here.
    const text = read(path);
    if (Array.isArray(expected)) {
      expect(expected.filter((part) => !text.includes(part))).toEqual([]);
    } else {
      expect(text).toBe(expected);
    }
  });

  test("retires every stale record's file: deletes the platform's own write, holds an edited one, hands over a tailed region", () => {
    // Which records are stale is sync.ts's selection over the manifest against files.yml; retire.test pins
    // each outcome given the list. The handover's merged blank lines are #203 (no headless blank lead).
    expect(summary.retired).toEqual([
      { path: ".github/old-tool.yml", outcome: "deleted", detail: "no longer selected" },
      {
        path: ".github/workflows/release.yml",
        outcome: "held",
        detail: "the content differs from the last write",
      },
      { path: "SECURITY.md", outcome: "deleted", detail: "no longer selected" },
      { path: "OLD_NOTES.md", outcome: "deleted", detail: "no longer selected" },
      {
        path: "CONTRIBUTING.md",
        outcome: "region removed",
        detail:
          "no longer selected; repository-owned content kept as a plain file; the region is gone, so read the file whole, give it a heading and intro if it lost them, or delete it",
      },
      { path: "HANDMADE.md", outcome: "deleted", detail: "no longer selected" },
    ]);
    expect(existsSync(join(target, "HANDMADE.md"))).toBe(false);
    expect(summary.notes).not.toContainEqual(expect.stringContaining("HANDMADE-GONE.md"));
    expect(summary.retired.map((row) => row.path)).not.toContain("CLAUDE.md");
    expect(existsSync(join(target, ".github/old-tool.yml"))).toBe(false);
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

  test("mirrors the written files, the fleet's symlinks first, literals before globs, replacing what stands at a target", () => {
    // Row order across files.yml's and the registration's declarations is visible only in a whole run;
    // mirrors.test pins each outcome alone. A blocked target left standing was #187.
    const mirror = (source: string, path: string, outcome: string, detail = "") => ({
      source,
      target: path,
      outcome,
      detail,
    });
    expect(summary.mirrors).toEqual([
      mirror("AGENTS.md", "CLAUDE.md", "current"),
      mirror("AGENTS.md", ".github/agents.md", "written"),
      mirror("AGENTS.md", ".github/copilot-instructions.md", "replaced local edits"),
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
    // The fleet's links: the recorded one current, the absent one written, the hand-written file replaced
    // and its text shown as the diff against the link target.
    for (const [path, to] of Object.entries(FLEET_LINKS)) {
      expect(lstatSync(join(target, path)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(target, path))).toBe(to);
      expect(read(path)).toBe(read("AGENTS.md"));
    }
    expect(stdout).toContain(
      "#### `.github/copilot-instructions.md`\n\n```diff\n--- .github/copilot-instructions.md\n+++ .github/copilot-instructions.md\n@@\n-# my own copilot notes\n-\n+../AGENTS.md",
    );
  });

  test("records what it wrote in the manifest; the self entry carries the build and no hash", () => {
    // The manifest is the contract the next sync and validate-managed-files read; a held retirement's record
    // dropped here makes the next run forget the platform's last write, so the held row and its hold vanish
    // while the file stays edited.
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
        ...Object.keys(FLEET_LINKS),
        ".github/dependabot.yml",
        ".github/workflows/checks.yml",
        HOOK,
        ".editorconfig",
        ".gitattributes",
        ".yamllint",
        "constructor",
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
    for (const [path, to] of Object.entries(FLEET_LINKS)) {
      expect(manifest.files[path]).toEqual({ class: "mirror", kind: "symlink", hash: sha256(to) });
    }
    const regionRecord = (body: string) => ({
      class: "split",
      grammar: "managed-region",
      begin: HASH_BEGIN,
      end: HASH_END,
      hash: sha256(`${HASH_BEGIN}\n${body}\n${HASH_END}\n`),
    });
    expect(manifest.files[".gitattributes"]).toEqual(regionRecord("* text=auto"));
    expect(manifest.files[".yamllint"]).toEqual(regionRecord("extends: default"));
    expect(Object.entries(manifest.files).find(([path]) => path === "constructor")?.[1]).toEqual({
      class: "managed",
      hash: sha256("platform notes\n"),
    });
    expect(manifest.files["HANDMADE-GONE.md"]).toBeUndefined();
    expect(manifest.files[".github/dependabot.yml"]).toEqual({
      class: "managed",
      hash: sha256(read(".github/dependabot.yml")),
    });
    expect(manifest.files[".editorconfig"]).toMatchObject({
      class: "split",
      hash: sha256(read(".editorconfig")),
    });
    // A starter nothing selects is the repository's own: its record leaves, the file stays.
    expect(manifest.files[".github/workflows/old-starter.yml"]).toBeUndefined();
    expect(manifest.files[".github/workflows/deselected-starter.yml"]).toBeUndefined();
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
    // A held retirement keeps its record, so a later sync can still recognise the platform's last write.
    expect(manifest.files[".github/workflows/release.yml"]).toEqual({
      class: "managed",
      hash: sha256("name: release\n"),
    });
  });

  test("names the build and the selection in the report header, and holds for review with one reason per hold source in report order", () => {
    // The header row is the sync's identity in the PR body. report.test builds the report's inputs by hand, so
    // the build and selection reaching it are pinned here. The hold list is the run's review agenda.
    expect(stdout).toContain(
      `| \`${BUILD}\` | \`bun\`, \`deno\`, \`docs-site\`, \`fuzzer\` | public |`,
    );
    expect(summary.hold).toBe(true);
    expect(summary.holdReasons).toEqual([
      ".gitattributes: the managed region was added above repository-owned content",
      ".yamllint: the managed region was added above repository-owned content",
      ".dockerignore: the managed region was added above repository-owned content",
      "local edits replaced in .github/workflows/ci.yml",
      "local edits replaced in .github/dependabot.yml",
      "local edits replaced in constructor",
      "local edits replaced in .github/copilot-instructions.md",
      "local edits replaced in template/LICENSE.md",
      "local edits replaced in skills/beta/LICENSE.md",
      "local edits replaced in skills/gamma/LICENSE.md",
      "retirement of .github/workflows/release.yml held: the content differs from the last write",
      "retirement of CONTRIBUTING.md: the managed region was removed and the repository-owned content kept",
      "mirror plain replaced: a directory stood at the target",
      "mirror skills/alpha/README.md/LICENSE.md replaced: a file stood at ancestor 'skills/alpha/README.md'",
      `registration: ${noWriterNote(".github/old-tool.yml")}`,
      `registration: ${noWriterNote(".github/workflows/release.yml")}`,
      `registration: ${noWriterNote("SECURITY.md")}`,
      `registration: ${noWriterNote("OLD_NOTES.md")}`,
      `registration: ${noWriterNote("CONTRIBUTING.md")}`,
      "registration: manifest record for `../escape.txt` ignored: the path carries an empty, '.', or '..' segment",
      `registration: ${noWriterNote("HANDMADE.md")}`,
      `registration: ${droppedMirrorNote("docs/old-mirror.md")}`,
      `registration: ${droppedMirrorNote("other/loop/sub/x.md")}`,
    ]);
  });

  test("a second run under the same build changes no byte and reports every file unchanged", () => {
    // Convergence is a two-run fact: the manifest written must read back as what the writers compare against.
    const before = snapshotTree(target);
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
    ]);
    for (const path of [".dockerignore", ".gitattributes", ".yamllint"]) {
      expect(again.summary.holdReasons).not.toContainEqual(expect.stringContaining(path));
    }
    // The handed-over split file is the repository's own now: no row, no hold.
    expect(again.summary.holdReasons).not.toContainEqual(
      expect.stringContaining("CONTRIBUTING.md"),
    );
    expect(again.summary.holdReasons).toEqual(
      summary.holdReasons.filter(
        (r) =>
          !r.startsWith("local edits") &&
          !r.startsWith("mirror ") &&
          (!r.includes("manifest record") || r.includes("`.github/workflows/release.yml`")) &&
          !r.endsWith("the managed region was added above repository-owned content") &&
          !r.startsWith("retirement of CONTRIBUTING.md"),
      ),
    );
    expect(snapshotTree(target)).toEqual(before);
  });
});

describe("sync.ts over a repository whose settings or overlay path is taken", () => {
  // The settings render edge cases of #215: a directory the render does not read through, a rendered document
  // with no record, one under a stale starter record.
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
    {
      reason:
        "a rendered settings.yml under a stale starter record, the repository's overlay beside it",
      seed: (target: string) => {
        writeFileSync(join(target, SETTINGS), RENDERED_STALE);
        writeFileSync(join(target, OVERLAY), THEIRS);
        writeFileSync(
          join(target, MANIFEST),
          `{\n  "files": {\n    ${JSON.stringify(MANIFEST)}: {"class": "managed", "hash": null},\n    ${JSON.stringify(SETTINGS)}: {"class": "starter"}\n  }\n}\n`,
        );
      },
      rows: [
        row(OVERLAY, "starter", "unchanged"),
        row(
          SETTINGS,
          "managed",
          "replaced local edits",
          "class changed from starter to managed; the record was stale, so the file was judged unrecorded",
        ),
      ],
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
    // The hold chain (the overlay starter held, so the render holds) and the note deduplicated across entries
    // live in sync.ts.
    const target = temp.dir("sync-e2e-bare-target-");
    // The fleet's symlinks are excepted: their held source would fail the run (the next test).
    writeFileSync(
      join(target, ".repo-platform.yml"),
      'modules: [bun, fuzzer]\nproject: {name: Demo, slug: demo, description: ""}\n' +
        `except: [${Object.keys(FLEET_LINKS).join(", ")}]\n`,
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
    for (const path of Object.keys(FLEET_LINKS)) expect(existsSync(join(target, path))).toBe(false);
  });

  test("the fleet's mirror of a held source fails the run, naming files.yml as the declaring document", () => {
    // mirrors.test pins the message under the registration; files.yml's attribution is the fleet declaration's alone.
    const target = temp.dir("sync-e2e-held-source-target-");
    writeFileSync(
      join(target, ".repo-platform.yml"),
      'modules: [bun]\nproject: {name: Demo, slug: demo, description: ""}\n',
    );
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const result = spawnSync(
      target,
      join(temp.dir("sync-e2e-held-source-summary-"), "summary.json"),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      `${Object.keys(FLEET_LINKS)
        .map(
          (path) =>
            `::error::files.yml: mirrors: source 'AGENTS.md', target '${path}': the source was held this run, so there is nothing to copy`,
        )
        .join("\n")}\n`,
    );
    expect(existsSync(join(target, MANIFEST))).toBe(false);
  });
});

describe("sync.ts over an upstream that does not serve a registered block", () => {
  test("exits nonzero with the one HTTP line, before anything is written", async () => {
    // upstream.test pins the message; that the fetch comes before any write is the run's.
    const target = temp.dir("sync-e2e-upstream-target-");
    writeFileSync(
      join(target, ".repo-platform.yml"),
      "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n",
    );
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const before = snapshotTree(target);
    const empty = await spawnUpstream(temp.dir("sync-e2e-upstream-empty-"));
    const summary = join(temp.dir("sync-e2e-upstream-summary-"), "summary.json");
    try {
      expect(spawnSync(target, summary, BUILD, ["--upstream", empty.host])).toEqual({
        exitCode: 1,
        stdout: `::error::GET ${empty.host}/github/gitignore/0123456789abcdef0123456789abcdef01234567/Global/Windows.gitignore failed: HTTP 404\n`,
        stderr: "",
      });
    } finally {
      empty.stop();
    }
    expect(snapshotTree(target)).toEqual(before);
    expect(existsSync(summary)).toBe(false);
  });
});

describe("sync.ts refusing at the command line or the registration", () => {
  // The --build regex lives in sync.ts's main, not flags.ts, so this is its only home: the build is recorded as
  // given into the PR body and the commit subject (#215). The flag set is sync.ts's too; flags.test parses a
  // synthetic set, so the retired --previous-files staying refused is pinned here. The module refusal is the
  // plan's; that it comes before any write is the run's.
  const REGISTRATION = "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n";
  test.each<{
    reason: string;
    build?: string;
    registration?: string;
    extra?: string[];
    error: string;
  }>([
    {
      reason: "a short --build sha",
      build: BUILD.slice(0, 12),
      error: `--build must be the build commit's full sha (40 lowercase hex characters), got "${BUILD.slice(0, 12)}"`,
    },
    {
      reason: "an uppercase --build sha",
      build: BUILD.toUpperCase(),
      error: `--build must be the build commit's full sha (40 lowercase hex characters), got "${BUILD.toUpperCase()}"`,
    },
    {
      reason: "the retired --previous-files flag",
      extra: ["--previous-files", join(FIXTURES, "files.yml")],
      error:
        'unknown or valueless argument "--previous-files" - allowed flags: --files, --tree, --target, --build, --repository, --private, --summary, --upstream',
    },
    {
      reason: "a registration naming a module files.yml does not offer",
      registration: "modules: [bun, uv]\nproject: {name: Demo, slug: demo, description: A demo}\n",
      error:
        '.repo-platform.yml: module "uv" is not a module files.yml offers (known: bun, deno, pages, docs-site, fuzzer)',
    },
  ])(
    "$reason is refused before anything is written",
    ({ build = BUILD, registration = REGISTRATION, extra = [], error }) => {
      const target = temp.dir("sync-e2e-refused-target-");
      writeFileSync(join(target, ".repo-platform.yml"), registration);
      fixtureGit(target, ["init", "-q", "-b", "main"]);
      const before = snapshotTree(target);
      const summary = join(temp.dir("sync-e2e-refused-summary-"), "summary.json");
      expect(spawnSync(target, summary, build, extra)).toEqual({
        exitCode: 1,
        stdout: `::error::${error}\n`,
        stderr: "",
      });
      expect(snapshotTree(target)).toEqual(before);
      expect(existsSync(summary)).toBe(false);
    },
  );
});

describe("sync.ts over a mirror declaration it cannot write", () => {
  function seed(registration: string): string {
    const target = temp.dir("sync-e2e-mirror-target-");
    writeFileSync(join(target, ".repo-platform.yml"), registration);
    mkdirSync(join(target, "skills/a"), { recursive: true });
    writeFileSync(join(target, "skills/a/README.md"), "");
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    return target;
  }
  const read = (target: string, rel: string) => readFileSync(join(target, rel), "utf-8");
  const error = (
    source: string,
    target: string,
    problem: string,
    declared = ".repo-platform.yml",
  ) => `::error::${declared}: mirrors: source '${source}', target '${target}': ${problem}`;

  test("an impossible declaration exits nonzero naming every problem, and records nothing", () => {
    // Each message has a unit home (plan/mirrors.test, writer/mirrors.test); the fleet-versus-registration
    // double claim, the excepted file left alone, and the stale manifest byte-identical after the refusal are
    // whole-run facts.
    const own = "my own dependabot\n";
    const target = seed(
      [
        "modules: [bun]",
        "project: {name: Demo, slug: demo, description: A demo}",
        "except: [.github/dependabot.yml]",
        "mirrors:",
        "  - {source: LICENSE.md, targets: [copies/a, copies/a/b, .github/repo-platform-manifest.json, .github/dependabot.yml, .github/dependabot.yml/copy.md]}",
        "  - {source: README.md, targets: [skills/*/README.md]}",
        "  - {source: LICENSE.md, targets: [docs/GONE.md, docs/**/LICENSE.md]}",
        // A target the fleet's mirror claims: one path, one claimant, both documents named.
        "  - {source: LICENSE.md, targets: [CLAUDE.md]}",
        "",
      ].join("\n"),
    );
    // A managed record of a module no longer selected: the run retires it,
    // and no mirror may land there.
    const stale = `{\n  "files": {\n    "docs/GONE.md": {"class": "managed", "hash": "${sha256("gone\n")}"}\n  }\n}\n`;
    mkdirSync(join(target, ".github"));
    writeFileSync(join(target, MANIFEST), stale);
    writeFileSync(join(target, ".github/dependabot.yml"), own);
    const result = spawnSync(target, join(temp.dir("sync-e2e-mirror-summary-"), "summary.json"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${[
        error("LICENSE.md", MANIFEST, "the target is a path files.yml writes"),
        error(
          "LICENSE.md",
          ".github/dependabot.yml",
          "the target is a path the registration excepts",
        ),
        error(
          "LICENSE.md",
          ".github/dependabot.yml/copy.md",
          "the target sits under '.github/dependabot.yml', a path the registration excepts",
        ),
        error(
          "README.md",
          "skills/*/README.md",
          "the source is not a managed or split file files.yml writes for this repository",
        ),
        error("LICENSE.md", "docs/GONE.md", "the target is a path a stale manifest record retires"),
        error("LICENSE.md", "docs/**/LICENSE.md", "the pattern uses '**'"),
        error(
          "AGENTS.md",
          "CLAUDE.md",
          "the target is claimed by more than one source",
          "files.yml",
        ),
        error(
          "AGENTS.md",
          "CLAUDE.md",
          "the target is claimed as a copy and as a symbolic link",
          "files.yml",
        ),
        error("LICENSE.md", "CLAUDE.md", "the target is claimed by more than one source"),
        error("LICENSE.md", "CLAUDE.md", "the target is claimed as a copy and as a symbolic link"),
        error(
          "LICENSE.md",
          "copies/a",
          "the target is a path prefix of another target 'copies/a/b'",
        ),
        error("LICENSE.md", "copies/a/b", "the target sits under another target 'copies/a'"),
      ].join("\n")}\n`,
    );
    expect(readFileSync(join(target, MANIFEST), "utf-8")).toBe(stale);
    expect(read(target, ".github/dependabot.yml")).toBe(own);
    expect(existsSync(join(target, "copies"))).toBe(false);
  });
});

describe("sync.ts over manifest records it cannot read", () => {
  // Each is a shape no writer of this platform stamps: a mirror kind it never writes, a split record without its
  // markers, a class it does not record or no longer records, a hash another tool left null, a starter carrying a field. The count is the
  // whole message: manifest keys are target content and the writer log reaches a public issue.
  const UNREADABLE = {
    ".github/old-tool.yml": `{"class": "mirror", "kind": "hardlink", "hash": "${sha256(OLD_TOOL)}"}`,
    "CONTRIBUTING.md": `{"class": "split", "grammar": "managed-region", "hash": "${sha256(OLD_CONTRIBUTING_REGION)}"}`,
    "BESPOKE.md": `{"class": "bespoke", "hash": "${sha256("b\n")}"}`,
    // The class the fleet's symlinks left behind; migrations/0001 restamps it before the writer runs.
    "CLAUDE.md": `{"class": "link", "hash": "${sha256("AGENTS.md")}"}`,
    "UNHASHED.md": '{"class": "managed", "hash": null}',
    "docs/old.md": '{"class": "starter", "hash": null}',
  };
  const manifestOf = (records: Record<string, string>) =>
    `{\n  "files": {\n${Object.entries(records)
      .map(([path, body]) => `    ${JSON.stringify(path)}: ${body}`)
      .join(",\n")}\n  }\n}\n`;
  const refusal = (count: number) =>
    `::error::${count} manifest ${count === 1 ? "record is" : "records are"} not a shape the writer ` +
    "records (an unknown class, a field the class does not carry, a hash that is not a sha256 digest, a " +
    "mirror kind other than symlink, a split without its grammar or markers); fix the manifest (git history " +
    "has the stamped original; the class table is actions/shared/manifest.ts), then dispatch the sync again\n";

  test.each<{ reason: string; records: Record<string, string> }>([
    { reason: "every unreadable shape at once", records: UNREADABLE },
    { reason: "one hash-null record", records: { "UNHASHED.md": UNREADABLE["UNHASHED.md"] } },
    {
      reason: "a starter record under a linked directory, which is never probed through the link",
      records: { "docs/old.md": UNREADABLE["docs/old.md"] },
    },
  ])("$reason fails the run with a count, and writes nothing", ({ records }) => {
    const target = temp.dir("sync-e2e-unreadable-target-");
    const files: Record<string, string> = {
      ".repo-platform.yml":
        "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n",
      ".github/old-tool.yml": OLD_TOOL,
      "CONTRIBUTING.md": OLD_CONTRIBUTING_REGION,
      "BESPOKE.md": "b\n",
      "UNHASHED.md": UNHASHED,
      [MANIFEST]: manifestOf(records),
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(target, rel)), { recursive: true });
      writeFileSync(join(target, rel), content);
    }
    symlinkSync("elsewhere", join(target, "docs"));
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const before = snapshotTree(target);
    const summary = join(temp.dir("sync-e2e-unreadable-summary-"), "summary.json");
    expect(spawnSync(target, summary)).toEqual({
      exitCode: 1,
      stdout: refusal(Object.keys(records).length),
      stderr: "",
    });
    expect(snapshotTree(target)).toEqual(before);
    expect(existsSync(summary)).toBe(false);
  });
});

describe("sync.ts over a registration with except", () => {
  test("an excepted path is neither written nor recorded; one no entry writes is a note that holds", () => {
    // except arrived when this repository became a target like any other (#299); the undeclared-path note is
    // sync.ts's.
    const target = temp.dir("sync-e2e-except-target-");
    writeFileSync(
      join(target, ".repo-platform.yml"),
      "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n" +
        "except: [.github/workflows/ci.yml, docs/nothing.md, CLAUDE.md]\n",
    );
    mkdirSync(join(target, ".github/workflows"), { recursive: true });
    writeFileSync(join(target, ".github/workflows/ci.yml"), LOCAL_CI);
    writeFileSync(join(target, "CLAUDE.md"), LOCAL_COPILOT);
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const { summary } = runSync(target, join(temp.dir("sync-e2e-except-summary-"), "summary.json"));
    const paths = summary.written.map((row) => row.path);
    expect(paths).not.toContain(".github/workflows/ci.yml");
    expect(paths).toContain("LICENSE.md");
    expect(readFileSync(join(target, ".github/workflows/ci.yml"), "utf-8")).toBe(LOCAL_CI);
    // An excepted fleet mirror target is the repository's own; the other targets still land.
    expect(readFileSync(join(target, "CLAUDE.md"), "utf-8")).toBe(LOCAL_COPILOT);
    expect(summary.mirrors.map((row) => row.target)).toEqual([
      ".github/agents.md",
      ".github/copilot-instructions.md",
    ]);
    const note = "`except` names `docs/nothing.md`, a path no files.yml entry writes";
    expect(summary.notes).toEqual([note]);
    expect(summary.hold).toBe(true);
    expect(summary.holdReasons).toContain(`registration: ${note}`);
    const manifest = JSON.parse(readFileSync(join(target, MANIFEST), "utf-8")) as {
      files: Record<string, unknown>;
    };
    expect(manifest.files[".github/workflows/ci.yml"]).toBeUndefined();
    expect(manifest.files["CLAUDE.md"]).toBeUndefined();
  });
});

describe("sync.ts over a target that excepts a path an earlier sync recorded", () => {
  test("each record is released: the file stays byte for byte, the record leaves, one Retired row, no hold", () => {
    // A two-run fact: a path an earlier sync recorded and the registration excepts later is released, not
    // retired; retire.test pins release() alone.
    const target = temp.dir("sync-e2e-release-target-");
    const registration = "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n";
    writeFileSync(join(target, ".repo-platform.yml"), registration);
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    const first = runSync(target, join(temp.dir("sync-e2e-release-summary1-"), "summary.json"));
    expect(first.summary.written).toContainEqual({
      path: ".github/workflows/ci.yml",
      class: "managed",
      change: "created",
      detail: "",
    });
    const excepted = [".github/workflows/checks.yml", ".github/workflows/ci.yml"];
    const before = excepted.map((path) => readFileSync(join(target, path), "utf-8"));
    writeFileSync(
      join(target, ".repo-platform.yml"),
      `${registration}except: [${excepted.join(", ")}]\n`,
    );
    const second = runSync(target, join(temp.dir("sync-e2e-release-summary2-"), "summary.json"));
    expect(excepted.map((path) => readFileSync(join(target, path), "utf-8"))).toEqual(before);
    expect(second.summary.retired).toEqual(
      excepted.map((path) => ({
        path,
        outcome: "released",
        detail:
          "excepted by the registration; the record leaves and the file stays as it is, the repository's own",
      })),
    );
    expect(second.summary.notes).toEqual([]);
    expect(second.summary.hold).toBe(false);
    const manifest = JSON.parse(readFileSync(join(target, MANIFEST), "utf-8")) as {
      files: Record<string, unknown>;
    };
    for (const path of excepted) expect(manifest.files[path]).toBeUndefined();
  });
});
