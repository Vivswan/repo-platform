// One overlay starter serves both visibilities: the writer fills `{{private}}` from its own flag.

import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";
import { spawnStubUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const OVERLAY = ".github/settings.local.yml";

// This test reads the overlay alone, so every upstream file is a stub and never the network.
const upstream = await spawnStubUpstream(
  parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8")),
  temp.dir("overlay-starter-upstream-"),
);
afterAll(() => upstream.stop());

function writtenOverlay(isPrivate: boolean): string {
  const target = temp.dir(`overlay-starter-${isPrivate ? "private" : "public"}-`);
  writeFileSync(
    join(target, ".repo-platform.yml"),
    "modules: []\nproject:\n  name: Demo\n  slug: demo\n  description: A demo\n",
  );
  const result = boundedSpawnSync(
    [
      "bun",
      SYNC,
      "--files",
      join(REPO_ROOT, "files.yml"),
      "--tree",
      join(REPO_ROOT, "files"),
      "--target",
      target,
      "--build",
      "0".repeat(40),
      "--repository",
      "owner/demo",
      "--private",
      String(isPrivate),
      "--upstream",
      upstream.host,
    ],
    { cwd: REPO_ROOT, timeoutMs: 60_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return readFileSync(join(target, OVERLAY), "utf-8");
}

test("the written overlay declares the repository's visibility, and that line is the only one that differs", () => {
  const written = { public: writtenOverlay(false), private: writtenOverlay(true) };
  for (const [visibility, text] of Object.entries(written)) {
    expect(text).not.toContain("{{");
    expect(parseYaml(text)).toEqual({
      repository: {
        description: "A demo",
        topics: [],
        private: visibility === "private",
      },
    });
  }
  expect(written.public.split("  private: false\n")).toHaveLength(2);
  expect(written.private).toBe(written.public.replace("  private: false\n", "  private: true\n"));
});
