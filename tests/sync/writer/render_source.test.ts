// The proof that the upstream `always` blocks land on every selection: the render with them is the render without
// them plus exactly the three OS sections, right after the base and before any module block.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSourced } from "../../../.github/scripts/sync/writer/render_source.ts";
import { fetchUpstreamBodies } from "../../../.github/scripts/sync/writer/upstream_blocks.ts";
import { type FileEntry, parseFilesConfig } from "../../../actions/plan/files_config.ts";

const FIXTURES = join(import.meta.dir, "../../ci/sync_end_to_end/fixtures");
const TREE = join(FIXTURES, "files");
const config = parseFilesConfig(readFileSync(join(FIXTURES, "files.yml"), "utf-8"));
type Sourced = Extract<FileEntry, { source: string }>;
const gitignore = config.files.find((entry) => entry.path === ".gitignore") as Sourced;
const BASE = readFileSync(join(TREE, "base/.gitignore"), "utf-8");
const OS_BLOCKS =
  "## Windows (github/gitignore Global/Windows.gitignore)\nThumbs.db\n\n" +
  "## macOS (github/gitignore Global/macOS.gitignore)\n.DS_Store\nIcon?\n\n" +
  "## Linux (github/gitignore Global/Linux.gitignore)\n*~\n\n";

// The fixture upstream read straight from disk: the same bytes the e2e test serves over loopback.
const bodies = await fetchUpstreamBodies([gitignore], "http://upstream", (url) =>
  Bun.file(join(FIXTURES, "upstream", url.split("/").slice(6).join("/"))).text(),
);
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
