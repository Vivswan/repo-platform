// git_head.ts's HEAD probe: null for a genuinely-absent path, a THROW on a
// real git failure. The throw is value-free by discipline - it must stay
// safe even if a caller ever logs it unwrapped, so it names no path, root,
// or git stderr, any of which can be private-repo content.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headBytes } from "../../.github/scripts/shared/git_head.ts";

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

describe("headBytes value-free failure", () => {
  test("a git failure names the subcommand and exit code, never the path, root, or git stderr", () => {
    // A fresh non-repo directory forces `git ls-tree HEAD` to fail.
    const root = mkdtempSync(join(tmpdir(), "head-bytes-not-a-repo-"));
    const rel = "super/secret-private-path.txt";
    let err: unknown;
    try {
      withoutGitEnv(() => headBytes(root, rel));
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

  test("a genuinely absent path returns null, not a throw", () => {
    // A real git repo with a committed file: probing a DIFFERENT path is
    // absence (null), while the broken-repo case above is the throw - the
    // two must stay distinguishable.
    const root = mkdtempSync(join(tmpdir(), "head-bytes-repo-"));
    const run = (...args: string[]) => {
      const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    };
    withoutGitEnv(() => {
      run("init", "-q", "-b", "main");
      run("config", "user.email", "t@example.com");
      run("config", "user.name", "t");
      writeFileSync(join(root, "present.txt"), "x");
      run("add", "-A");
      run("commit", "-qm", "init");
      expect(headBytes(root, "present.txt")?.toString("latin1")).toBe("x");
      expect(headBytes(root, "absent.txt")).toBeNull();
    });
  });
});
