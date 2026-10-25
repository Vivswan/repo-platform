// The owned tail below END nests under the region's last heading, so that
// heading must be the repository-specific one with or without blocks. The test
// reads AGENTS.md alone, so every upstream file is a stub and never the network.

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FileEntry, parseFilesConfig } from "../../actions/plan/files_config";
import { syncedCheckout } from "../shared/synced_checkout";
import { tempDirs } from "../shared/temp_dir";
import { spawnStubUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const FILES_TREE = join(REPO_ROOT, "files");

const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const upstream = await spawnStubUpstream(config, temp.dir("agents-tail-upstream-"));
afterAll(() => upstream.stop());

function writtenAgents(label: string, modules: string[]): string {
  const target = temp.dir(`agents-tail-${label}-`);
  syncedCheckout({ target, upstream: upstream.host, modules });
  return readFileSync(join(target, "AGENTS.md"), "utf-8");
}

const toolchainAgents = config.files.find(
  (entry) => entry.path === "AGENTS.md" && "blocks" in entry && entry.blocks !== undefined,
) as Extract<FileEntry, { sources: unknown }>;
const bunToolchain = toolchainAgents.sources.bun;
if (typeof bunToolchain !== "string") {
  throw new Error("the bun toolchain block is not a tree file");
}
const bunBlock = readFileSync(join(FILES_TREE, bunToolchain), "utf-8");

test.each([
  ["no toolchain", [], []],
  ["bun", ["bun"], ["## Toolchain", "", ...bunBlock.trimEnd().split("\n")]],
])(
  "the AGENTS.md region ends with the repository-specific heading (%s)",
  (label, modules, above) => {
    const lines = writtenAgents(label.replace(" ", "-"), modules).split("\n");
    const end = lines.indexOf("<!-- END REPO-PLATFORM MANAGED -->");
    expect(lines.slice(end - above.length - 4, end + 2)).toEqual([
      ...above,
      "",
      "## Repository-specific guidance",
      "",
      "<!-- Add project-specific instructions below the END marker; they are this repository's own and survive every sync. -->",
      "<!-- END REPO-PLATFORM MANAGED -->",
      "",
    ]);
  },
);
