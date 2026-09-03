import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKIP_DIRS, walkFiles } from "../../.github/scripts/sync/walk.ts";

/** The conflict-recovery skip set, spelled out: every name is planted in
 * the fixture below, so a member dropped from SKIP_DIRS surfaces as an
 * extra walked path and a member added fails the set equality. */
const SKIP_NAMES = [".git", ".repo-platform-src", "node_modules", ".venv", "__pycache__"];

describe("walkFiles", () => {
  test("returns regular files sorted, skipping every SKIP_DIRS name and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "walk-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "b.txt"), "b");
    writeFileSync(join(root, "docs", "a.md"), "a");
    for (const name of SKIP_NAMES) {
      mkdirSync(join(root, name, "pkg"), { recursive: true });
      writeFileSync(join(root, name, "pkg", "index.js"), "skip");
    }
    symlinkSync("b.txt", join(root, "link.txt"));
    expect(walkFiles(root)).toEqual(["b.txt", "docs/a.md"]);
    expect([...SKIP_DIRS].sort()).toEqual([...SKIP_NAMES].sort());
  });

  test("a SKIP_DIRS name is skipped as a FILE too, matching the legacy copies", () => {
    // Both conflict-recovery passes skipped the name before stat-ing it;
    // the shared walk must keep that shape or the passes would diverge
    // from their history on a file literally named node_modules.
    const root = mkdtempSync(join(tmpdir(), "walk-"));
    writeFileSync(join(root, "node_modules"), "a file, not a directory");
    writeFileSync(join(root, "kept.txt"), "kept");
    expect(walkFiles(root)).toEqual(["kept.txt"]);
  });
});
