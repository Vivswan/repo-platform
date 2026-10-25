// One overlay starter serves both visibilities: the writer fills `{{private}}` from its own flag. The test reads the
// overlay alone, so every upstream file is a stub and never the network.

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { syncedCheckout } from "../shared/synced_checkout";
import { tempDirs } from "../shared/temp_dir";
import { spawnStubUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const OVERLAY = ".github/settings.local.yml";

const upstream = await spawnStubUpstream(
  parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8")),
  temp.dir("overlay-starter-upstream-"),
);
afterAll(() => upstream.stop());

function writtenOverlay(isPrivate: boolean): string {
  const target = temp.dir(`overlay-starter-${isPrivate ? "private" : "public"}-`);
  syncedCheckout({ target, upstream: upstream.host, private: isPrivate });
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
