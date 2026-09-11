import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILES_CONFIG, moduleRoster } from "../../.github/scripts/sync/modules";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

describe("moduleRoster", () => {
  test("reads files.yml's modules keys in the file's order", () => {
    const dir = temp.dir("roster-");
    const path = join(dir, "files.yml");
    writeFileSync(
      path,
      "placeholders: []\nmodules:\n  uv: {}\n  bun: {}\n  pages: {}\nfiles: []\n",
    );
    expect(moduleRoster(path)).toEqual(["uv", "bun", "pages"]);
  });

  test("the default path is this repository's files.yml, which carries the bun module", () => {
    expect(FILES_CONFIG.endsWith("/files.yml")).toBe(true);
    expect(moduleRoster()).toContain("bun");
  });

  test("a data file the grammar refuses throws, naming the file", () => {
    const dir = temp.dir("roster-bad-");
    const path = join(dir, "files.yml");
    writeFileSync(path, "modules: [a, b]\n");
    expect(() => moduleRoster(path)).toThrow("files.yml");
  });
});
