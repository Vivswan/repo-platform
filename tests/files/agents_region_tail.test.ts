// The owned tail below END nests under the region's last heading, so that
// heading must be the repository-specific one with or without blocks.

import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FileEntry, parseFilesConfig } from "../../actions/plan/files_config";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";
import { spawnStubUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const FILES_TREE = join(REPO_ROOT, "files");
const BUILD = "0".repeat(40);

// This test reads AGENTS.md alone, so every upstream file is a stub and never the network.
const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const upstream = await spawnStubUpstream(config, temp.dir("agents-tail-upstream-"));
afterAll(() => upstream.stop());

function writtenAgents(label: string, modules: string[]): string {
  const target = temp.dir(`agents-tail-${label}-`);
  writeFileSync(
    join(target, ".repo-platform.yml"),
    [
      `modules: ${JSON.stringify(modules)}`,
      "project:",
      "  name: Demo",
      "  slug: demo",
      "  description: A demo",
      "  copyright_holder: Owner",
      "",
    ].join("\n"),
  );
  const result = boundedSpawnSync(
    [
      "bun",
      SYNC,
      "--files",
      join(REPO_ROOT, "files.yml"),
      "--tree",
      FILES_TREE,
      "--target",
      target,
      "--build",
      BUILD,
      "--repository",
      "owner/demo",
      "--private",
      "false",
      "--upstream",
      upstream.host,
    ],
    { cwd: REPO_ROOT, timeoutMs: 60_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return readFileSync(join(target, "AGENTS.md"), "utf-8");
}

const toolchainAgents = config.files.find(
  (entry) => entry.path === "AGENTS.md" && "blocks" in entry && entry.blocks !== undefined,
) as Extract<FileEntry, { sources: unknown }>;
const bunToolchain = toolchainAgents.sources.bun;
if (typeof bunToolchain !== "string") throw new Error("the bun toolchain block is not a tree file");
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
