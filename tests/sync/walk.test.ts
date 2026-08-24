import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKIP_DIRS, walkFiles } from "../../.github/scripts/sync/walk.ts";

describe("walkFiles", () => {
  test("returns regular files sorted, skipping SKIP_DIRS and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "walk-"));
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "b.txt"), "b");
    writeFileSync(join(root, "docs", "a.md"), "a");
    writeFileSync(join(root, ".git", "config"), "skip");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "skip");
    symlinkSync("b.txt", join(root, "link.txt"));
    expect(walkFiles(root)).toEqual(["b.txt", "docs/a.md"]);
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

  test("SKIP_DIRS carries the conflict-recovery skip set", () => {
    expect([...SKIP_DIRS].sort()).toEqual(
      [".git", ".repo-platform-src", "node_modules", ".venv", "__pycache__"].sort(),
    );
  });
});
