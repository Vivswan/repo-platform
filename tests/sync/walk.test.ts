import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "../../.github/scripts/sync/walk.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

test("walkFiles lists every regular file sorted, whatever its directory is named, and no symlink", () => {
  const root = temp.dir("walk-");
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "b.txt"), "b");
  writeFileSync(join(root, "docs", "a.md"), "a");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "walked too");
  symlinkSync("b.txt", join(root, "link.txt"));
  symlinkSync("docs", join(root, "linked-dir"));
  expect(walkFiles(root)).toEqual(["b.txt", "docs/a.md", "node_modules/pkg/index.js"]);
});
