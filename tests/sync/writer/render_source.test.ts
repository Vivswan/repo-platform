// Why a differential test: the always list is the only thing that may separate these two renders.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSourced, rewritten } from "../../../.github/scripts/sync/writer/render_source.ts";
import { fetchUpstream } from "../../../.github/scripts/sync/writer/upstream.ts";
import {
  type FileEntry,
  parseFilesConfig,
  type UpstreamRef,
  upstreamRefs,
} from "../../../actions/plan/files_config.ts";

const FIXTURES = join(import.meta.dir, "../../ci/sync_end_to_end/fixtures");
const TREE = join(FIXTURES, "files");
const config = parseFilesConfig(readFileSync(join(FIXTURES, "files.yml"), "utf-8"));
type Sourced = Extract<FileEntry, { source: string | UpstreamRef }>;
const gitignore = config.files.find((entry) => entry.path === ".gitignore") as Sourced;
const BASE = readFileSync(join(TREE, "base/.gitignore"), "utf-8");
const OS_BLOCKS =
  "## Windows (github/gitignore Global/Windows.gitignore)\nThumbs.db\n\n" +
  "## macOS (github/gitignore Global/macOS.gitignore)\n.DS_Store\nIcon?\n\n" +
  "## Linux (github/gitignore Global/Linux.gitignore)\n*~\n\n";
const SHA = "0123456789abcdef0123456789abcdef01234567";

// The fixture upstream read straight from disk: the same bytes the e2e test serves over loopback.
const fromDisk = (url: string) =>
  Bun.file(join(FIXTURES, "upstream", url.split("/").slice(6).join("/"))).text();
const bodies = await fetchUpstream(upstreamRefs(config.files), "http://upstream", fromDisk);
const withoutAlways = { ...gitignore, upstream: { ...gitignore.upstream, always: [] } } as Sourced;
const render = (entry: Sourced, modules: string[]) =>
  renderSourced(config, TREE, entry, modules, {}, bodies) as string;

describe("the always blocks", () => {
  test.each([[[]], [["bun"]], [["deno"]], [["bun", "deno", "fuzzer"]]])(
    "selection %j renders the base, then the three OS sections, then what it rendered without them",
    (modules) => {
      const plain = render(withoutAlways, modules);
      expect(plain).toContain(BASE);
      expect(render(gitignore, modules)).toBe(plain.replace(BASE, `${BASE}${OS_BLOCKS}`));
    },
  );
});

test("upstream and tree blocks splice in files.yml order, a shared upstream block once, the tree block last", () => {
  expect(render(gitignore, ["deno", "bun", "fuzzer"])).toBe(
    `# BEGIN REPO-PLATFORM MANAGED\n${BASE}${OS_BLOCKS}` +
      "## Node (github/gitignore Node.gitignore)\n*.log\n\n" +
      "## Bun (github/gitignore Bun.gitignore)\nbun.lockb\n\n" +
      "## Fuzzer\n/.fuzz-failures/\n" +
      "# END REPO-PLATFORM MANAGED\n",
  );
});

test("a declared replacement is literal: no replacement-string pattern is read", () => {
  expect(rewritten("a*b*", { "*": "$&", b: "$$" })).toBe("a$&$$$&");
});

describe("an entry whose source is an upstream ref", () => {
  const doc = (source: string, region: string, blocks = "    blocks: notes") =>
    parseFilesConfig(
      [
        "placeholders: []",
        "modules:",
        `  bun: ${blocks === "" ? "{}" : "{ notes: [Node] }"}`,
        "files:",
        "  - path: NOTES.md",
        `    ${region}`,
        `    source: ${source}`,
        blocks,
        `    upstream: {repository: github/gitignore, sha: ${SHA}, always: [Linux], paths: {Linux: Global/Linux.gitignore${blocks === "" ? "" : ", Node: Node.gitignore"}}}`,
        '    replace: {"*": "STAR"}',
        "",
      ].join("\n"),
    );
  const REF = `{repository: github/gitignore, sha: ${SHA}, path: Global/Windows.gitignore}`;

  test("an upstream without blocks still renders its always values on every selection", async () => {
    const parsed = doc(REF, "class: managed", "");
    const entry = parsed.files[0] as Sourced;
    const fetched = await fetchUpstream(upstreamRefs(parsed.files), "http://upstream", fromDisk);
    for (const modules of [[], ["bun"]]) {
      expect(renderSourced(parsed, TREE, entry, modules, {}, fetched)).toBe("Thumbs.db\nSTAR~\n\n");
    }
  });

  test.each([
    [
      "managed: the fetched source, then the blocks with no heading",
      "class: managed",
      REF,
      "Thumbs.db\nSTAR~\n\nSTAR.log\n\n",
    ],
    [
      "split, hash region: each fetched block under a # heading",
      "class: split\n    region: hash",
      REF,
      "# BEGIN REPO-PLATFORM MANAGED\nThumbs.db\n" +
        "## Linux (github/gitignore Global/Linux.gitignore)\nSTAR~\n\n" +
        "## Node (github/gitignore Node.gitignore)\nSTAR.log\n\n" +
        "# END REPO-PLATFORM MANAGED\n",
    ],
    [
      "split, html region: each fetched block under an html comment heading",
      "class: split\n    region: html",
      REF,
      "<!-- BEGIN REPO-PLATFORM MANAGED -->\nThumbs.db\n" +
        "<!-- Linux (github/gitignore Global/Linux.gitignore) -->\nSTAR~\n\n" +
        "<!-- Node (github/gitignore Node.gitignore) -->\nSTAR.log\n\n" +
        "<!-- END REPO-PLATFORM MANAGED -->\n",
    ],
    [
      "the same entry with a tree source renders the tree file, the blocks still fetched",
      "class: managed",
      "files/base/.gitignore",
      `${BASE}STAR~\n\nSTAR.log\n\n`,
    ],
  ])("%s", async (_case, region, source, expected) => {
    const parsed = doc(source, region);
    const entry = parsed.files[0] as Sourced;
    const fetched = await fetchUpstream(upstreamRefs(parsed.files), "http://upstream", fromDisk);
    expect(renderSourced(parsed, TREE, entry, ["bun"], {}, fetched)).toBe(expected);
  });
});
