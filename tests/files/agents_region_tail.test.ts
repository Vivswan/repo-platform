// The owned tail below END nests under the region's last heading, so that
// heading must be the repository-specific one with or without blocks.

import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockSourcePath } from "../../actions/plan/files_config";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const FILES_TREE = join(REPO_ROOT, "files");
const BUILD = "x".repeat(40);

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
    ],
    { cwd: REPO_ROOT, timeoutMs: 60_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return readFileSync(join(target, "AGENTS.md"), "utf-8");
}

const bunBlock = readFileSync(
  join(FILES_TREE, "bun", blockSourcePath("AGENTS.md", "toolchain")),
  "utf-8",
);

test.each([
  ["no toolchain", [], ["- Fleet-wide conventions: repo-platform's docs/fleet-guidelines.md."]],
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
