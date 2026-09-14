// files.yml declares where the rendered settings document lands; the code echoes the path once, in SETTINGS_PATH, and
// this test keeps the echo honest.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFilesConfig } from "../../actions/plan/files_config.ts";
import { SETTINGS_PATH } from "../../actions/shared/platform.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

test("SETTINGS_PATH is the path of files.yml's one render: settings row", () => {
  const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
  const rendered = config.files.filter((entry) => "render" in entry).map((entry) => entry.path);
  expect({ rendered, settingsPath: SETTINGS_PATH }).toEqual({
    rendered: [".github/settings.yml"],
    settingsPath: ".github/settings.yml",
  });
});
