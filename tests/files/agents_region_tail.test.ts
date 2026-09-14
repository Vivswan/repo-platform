// The owned tail below END nests under the region's last heading, so that
// heading must be the repository-specific one with or without blocks.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blockSource, parseFilesConfig } from "../../actions/plan/files_config";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";
import { spawnUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const FILES_TREE = join(REPO_ROOT, "files");
const BUILD = "0".repeat(40);

// The writer fetches every upstream block files.yml registers before it writes anything, so a stub of each registered path
// is served over loopback: this test reads AGENTS.md alone, never the network.
const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const stubs = temp.dir("agents-tail-upstream-");
for (const entry of config.files) {
  if (entry.class === "link" || "render" in entry || entry.upstream === undefined) continue;
  for (const path of Object.values(entry.upstream.paths)) {
    mkdirSync(dirname(join(stubs, path)), { recursive: true });
    writeFileSync(join(stubs, path), "# stub\n");
  }
}
const upstream = await spawnUpstream(stubs);
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

const bunToolchain = blockSource({ path: "AGENTS.md" }, "bun", "toolchain");
if (bunToolchain.kind !== "tree") throw new Error("AGENTS.md declares no upstream");
const bunBlock = readFileSync(join(FILES_TREE, bunToolchain.source), "utf-8");

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
