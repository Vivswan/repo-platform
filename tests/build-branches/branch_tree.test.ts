import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, destOverlapsRepo } from "../../.github/scripts/build-branches/branch_tree";

const REPO = "/home/user/repo-platform";

describe("destOverlapsRepo", () => {
  test("rejects the repository root itself", () => {
    expect(destOverlapsRepo(REPO, REPO)).toBe(true);
  });

  test("rejects every ancestor of the repository, including the filesystem root", () => {
    for (const dest of ["/", "/home", "/home/user"]) {
      expect(destOverlapsRepo(dest, REPO)).toBe(true);
    }
  });

  test("rejects paths inside the repository", () => {
    expect(destOverlapsRepo(`${REPO}/template`, REPO)).toBe(true);
  });

  test("accepts unrelated paths, including siblings sharing a name prefix", () => {
    for (const dest of ["/tmp/build-tree", "/home/user/repo-platform-scratch", "/home/other"]) {
      expect(destOverlapsRepo(dest, REPO)).toBe(false);
    }
  });
});

describe("canonicalize", () => {
  test("dereferences a symlinked parent so an alias of the repo still overlaps", () => {
    const root = mkdtempSync(join(tmpdir(), "bt-"));
    const repo = join(root, "real", "repo");
    mkdirSync(repo, { recursive: true });
    symlinkSync(join(root, "real"), join(root, "alias"));
    const aliased = canonicalize(join(root, "alias", "repo"));
    expect(destOverlapsRepo(aliased, canonicalize(repo))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("re-attaches a not-yet-existing tail unresolved", () => {
    const root = mkdtempSync(join(tmpdir(), "bt-"));
    expect(canonicalize(join(root, "no", "such", "dir"))).toBe(
      join(canonicalize(root), "no", "such", "dir"),
    );
    rmSync(root, { recursive: true, force: true });
  });
});
