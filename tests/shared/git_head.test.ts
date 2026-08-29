// git_head.ts's HEAD probe: a discriminated entry (blob bytes | non-blob
// kind | absent), and a THROW on a real git failure. The throw is
// value-free by discipline - it must stay safe even if a caller ever logs
// it unwrapped, so it names no path, root, or git stderr, any of which can
// be private-repo content. The non-blob arm exists because `git show
// HEAD:rel` answers for EVERY object kind: a directory yields tree-listing
// prose and a symlink yields its target path string, neither of which is
// file content - the union keeps them out of the blob arm by construction.

import { describe, expect, spyOn, test } from "bun:test";
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

/** A PATH shim whose git answers any ls-tree with `payload` (printf
 * escapes interpreted, so \t works) and delegates every other subcommand
 * to the real git - the fake-git pattern from
 * tests/sync/timeout_fail_closed.test.ts, aimed at output shape instead
 * of hanging. */
function lsTreeStubDir(payload: string): string {
  const real = Bun.which("git");
  if (real === null) throw new Error("git not on PATH");
  const dir = mkdtempSync(join(tmpdir(), "ls-tree-stub-"));
  writeFileSync(
    join(dir, "git"),
    [
      "#!/bin/sh",
      'for arg in "$@"; do',
      '  if [ "$arg" = "ls-tree" ]; then',
      `    printf '${payload}'`,
      "    exit 0",
      "  fi",
      "done",
      `exec ${real} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return dir;
}

/** headEntry(root, "present.txt") run in a DRIVER subprocess with the stub
 * git first on PATH: an in-process PATH mutation cannot reach headEntry's
 * spawns (bun resolves an inherited-env spawn against the startup PATH),
 * so the stub rides the driver's own startup environment instead - the
 * same wiring timeout_fail_closed.test.ts uses. */
function probeWithStubGit(root: string, payload: string): string {
  const driver = join(mkdtempSync(join(tmpdir(), "ls-tree-driver-")), "driver.ts");
  const probed = join(import.meta.dir, "../../.github/scripts/shared/git_head.ts");
  writeFileSync(
    driver,
    [
      `import { headEntry } from ${JSON.stringify(probed)};`,
      "try {",
      `  const entry = headEntry(${JSON.stringify(root)}, "present.txt");`,
      '  console.log("NO-THROW " + entry.kind);',
      "} catch (err) {",
      '  console.log("THREW " + (err instanceof Error ? err.message : String(err)));',
      "}",
      "",
    ].join("\n"),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  env.PATH = `${lsTreeStubDir(payload)}:${env.PATH}`;
  const proc = Bun.spawnSync([process.execPath, driver], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  return proc.stdout.toString();
}

describe("headEntry strict entry parse", () => {
  const root = makeFixtureRepo();

  test("a malformed ls-tree entry fails at the parse guard, never at the byte read", () => {
    // Real git cannot emit these shapes, so a stub git stands in. The
    // 2-field entry carries no oid at all; the 4-field entry smuggles a
    // VALID-HEX oid past a weakened length check (`!== 3` mutated down to
    // `< 2` survived the whole suite before this test). Without the
    // strict guard either shape flows on toward the byte read - the
    // value-free cat-file failure, or worse, a successful read of
    // whatever object the third field happens to name - instead of the
    // precise parse rejection pinned here.
    for (const payload of [
      "100644 blob\\tpresent.txt",
      "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa junk\\tpresent.txt",
    ]) {
      const out = probeWithStubGit(root, payload);
      expect(out).toContain("THREW");
      expect(out).toContain("a malformed entry line");
      expect(out).not.toContain("NO-THROW");
      expect(out).not.toContain("cat-file");
      expect(out).not.toContain(root);
    }
  });
});

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

  test("the blob byte-read consumes the ls-tree oid, never a second HEAD resolution", () => {
    // A real HEAD move between the discriminating ls-tree and the byte
    // read cannot be staged deterministically from in-process code, so the
    // TOCTOU guarantee is pinned structurally instead: the byte-read argv
    // must carry the oid ls-tree answered with (same object by
    // construction) and must not mention HEAD at all - a `git show
    // HEAD:rel` read would resolve HEAD a second time and could route a
    // non-blob's bytes through the blob arm.
    const expectedOid = withoutGitEnv(() => {
      const proc = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD:present.txt"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
      return proc.stdout.toString().trim();
    });
    const spy = spyOn(Bun, "spawnSync");
    try {
      const entry = withoutGitEnv(() => headEntry(root, "present.txt"));
      expect(entry.kind).toBe("blob");
      // Calls located by shape, never by argv position: exactly one
      // discrimination and one byte read is the pinned contract (a second
      // of either would be a re-resolution risk), while extra unrelated
      // probes would fail here loudly instead of silently shifting
      // indices.
      const argvs = spy.mock.calls.map((call) => call[0] as string[]);
      const discriminations = argvs.filter((argv) => argv.includes("ls-tree"));
      expect(discriminations.length).toBe(1);
      const reads = argvs.filter((argv) => argv.includes("cat-file"));
      expect(reads.length).toBe(1);
      expect(reads[0]).toContain("blob");
      expect(reads[0]).toContain(expectedOid);
      // Only the discrimination may name HEAD: any other call resolving it
      // is a second resolution the by-oid contract forbids.
      for (const argv of argvs) {
        if (argv === discriminations[0]) continue;
        expect(argv.some((arg) => arg.includes("HEAD"))).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
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
