// git_head.ts's HEAD probe: a discriminated entry (blob bytes | non-blob
// kind | absent), and a THROW on a real git failure. The throw is
// value-free by discipline - it must stay safe even if a caller ever logs
// it unwrapped, so it names no path, root, or git stderr, any of which can
// be private-repo content. The non-blob arm exists because `git show
// HEAD:rel` answers for EVERY object kind: a directory yields tree-listing
// prose and a symlink yields its target path string, neither of which is
// file content - the union keeps them out of the blob arm by construction.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headEntry } from "../../.github/scripts/shared/git_head.ts";

/** Run `fn` with every GIT_* variable removed from the environment, so a
 * hook-driven run (husky exports GIT_DIR/GIT_INDEX_FILE) cannot redirect
 * the spawned git away from the scratch directory and back into a real
 * repository - which would make the probe succeed instead of failing. */
function withoutGitEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

/** A scratch repository whose HEAD carries one of each object kind. */
function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "head-entry-repo-"));
  const run = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  };
  withoutGitEnv(() => {
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    writeFileSync(join(root, "present.txt"), "x");
    writeFileSync(join(root, "tool.sh"), "#!/bin/sh\n");
    chmodSync(join(root, "tool.sh"), 0o755);
    mkdirSync(join(root, "dir", "nested"), { recursive: true });
    writeFileSync(join(root, "dir", "nested", "inner.txt"), "inner\n");
    // The real managed-repo shape: CLAUDE.md and friends are symlinks to
    // AGENTS.md by design, so a link at HEAD is a first-class fixture.
    symlinkSync("present.txt", join(root, "link.md"));
    run("add", "-A");
    // A gitlink (submodule entry) without any submodule machinery: the
    // empty tree's oid stands in for the pinned commit.
    run(
      "update-index",
      "--add",
      "--cacheinfo",
      "160000,4b825dc642cb6eb9a060e54bf8d69288fbee4904,sub",
    );
    run("commit", "-qm", "init");
  });
  return root;
}

describe("headEntry value-free failure", () => {
  test("a git failure names the subcommand and exit code, never the path, root, or git stderr", () => {
    // A fresh non-repo directory forces `git ls-tree HEAD` to fail.
    const root = mkdtempSync(join(tmpdir(), "head-entry-not-a-repo-"));
    const rel = "super/secret-private-path.txt";
    let err: unknown;
    try {
      withoutGitEnv(() => headEntry(root, rel));
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;

    // Value-free: none of the target-derived detail may appear.
    expect(message).not.toContain(rel);
    expect(message).not.toContain("secret-private-path");
    expect(message).not.toContain(root);
    // git's own stderr (which quotes the root and paths) must not ride along.
    expect(message.toLowerCase()).not.toContain("not a git repository");
    expect(message.toLowerCase()).not.toContain("fatal");

    // But it must still say ENOUGH to diagnose: which probe, that it was a
    // git-level failure with an exit code, and where the withheld detail is.
    expect(message).toContain("ls-tree");
    expect(message).toMatch(/exit \d+/);
    expect(message).toContain("docs/private-repos.md");
  });
});

describe("headEntry discrimination", () => {
  const root = makeFixtureRepo();

  test("a regular file is a blob carrying its bytes", () => {
    const entry = withoutGitEnv(() => headEntry(root, "present.txt"));
    expect(entry.kind).toBe("blob");
    if (entry.kind !== "blob") throw new Error("unreachable");
    expect(entry.bytes.toString("latin1")).toBe("x");
  });

  test("an executable file (mode 100755) is a blob too", () => {
    const entry = withoutGitEnv(() => headEntry(root, "tool.sh"));
    expect(entry.kind).toBe("blob");
    if (entry.kind !== "blob") throw new Error("unreachable");
    expect(entry.bytes.toString("latin1")).toBe("#!/bin/sh\n");
  });

  test("a genuinely absent path is absent, not a throw", () => {
    // Same repo as the blob case, DIFFERENT path: absence and the
    // broken-repo throw above must stay distinguishable.
    expect(withoutGitEnv(() => headEntry(root, "absent.txt"))).toEqual({ kind: "absent" });
  });

  test("a directory is a non-blob, never tree-listing prose in the blob arm", () => {
    // `git show HEAD:dir` answers "tree HEAD:dir" plus entry names; the
    // old bytes probe returned exactly that as if it were file content.
    for (const rel of ["dir", "dir/nested"]) {
      expect(withoutGitEnv(() => headEntry(root, rel))).toEqual({
        kind: "non-blob",
        object: "directory",
        raw: "040000 tree",
      });
    }
  });

  test("a symlink is a non-blob, never its target string in the blob arm", () => {
    // `git show HEAD:link.md` answers "present.txt" - the target path,
    // not the linked file's content and not the link's "content" either.
    expect(withoutGitEnv(() => headEntry(root, "link.md"))).toEqual({
      kind: "non-blob",
      object: "symlink",
      raw: "120000 blob",
    });
  });

  test("a submodule gitlink is a non-blob", () => {
    expect(withoutGitEnv(() => headEntry(root, "sub"))).toEqual({
      kind: "non-blob",
      object: "submodule",
      raw: "160000 commit",
    });
  });

  test("a trailing-slash rel throws (value-free) instead of answering with a child entry", () => {
    // `ls-tree HEAD -- dir/` lists dir's CHILDREN; a single-child tree
    // would answer with that child's entry, which is not the probed path.
    for (const rel of ["dir/", "dir/nested/"]) {
      let err: unknown;
      try {
        withoutGitEnv(() => headEntry(root, rel));
      } catch (caught) {
        err = caught;
      }
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain("does not recognize");
      expect(message).not.toContain(root);
      expect(message).not.toContain("dir");
    }
  });
});
