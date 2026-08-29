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
import { capture } from "../../.github/scripts/shared/proc.ts";

/** Explicit env OVERLAY deleting every GIT_* variable, handed to this
 * file's own spawns at the call site (the repo's adopted style for tests
 * that scrub - ambient process.env mutation around a spawn stays fragile
 * under parallel test execution). Scrubbing matters because a hook-driven
 * run (husky exports GIT_DIR/GIT_INDEX_FILE) can redirect a spawned git
 * away from its scratch directory and back into a real repository. The
 * overlay shape: capture() MERGES options.env over live process.env, so
 * the scrub must arrive as undefined-VALUED entries - bun then omits the
 * keys - never as a filtered env copy, which would merge over the live
 * base without deleting anything. */
function gitFreeOverlay(): Record<string, string | undefined> {
  const overlay: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) overlay[key] = undefined;
  }
  return overlay;
}

/** Run `fn` with every GIT_* variable removed from process.env - the same
 * scrub as gitFreeOverlay, but for calls into headEntry, which takes no
 * env parameter, so the ambient mutation is the one channel this file has.
 * The mutation reaches headEntry's git because every spawn under it is
 * handed live process.env - proc.ts's contract, and the raw byte-read
 * spawn hands it explicitly too (bun's own default is a process-start
 * snapshot, which kept this scrub silently inert until the class was
 * closed - the poison-GIT_DIR test below pins that it genuinely bites
 * now). */
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
    // Through capture(): explicit scrub overlay, and the spawn stays
    // bounded (proc.ts's default hang bound) - a raw sync spawn blocks
    // the event loop, so bun-test's per-test cap could never interrupt
    // a hung child.
    const proc = capture(["git", "-C", root, ...args], { env: gitFreeOverlay() });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr}`);
  };
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
 * git first on PATH: the override rides the driver's own startup
 * environment, so it stays scoped to that one process - an in-process
 * PATH mutation would reach headEntry's spawns (they are handed live
 * process.env), but it would also poison every other spawn in this test
 * process. The same wiring timeout_fail_closed.test.ts uses. */
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
  const env = gitFreeOverlay();
  env.PATH = `${lsTreeStubDir(payload)}:${process.env.PATH}`;
  // Through capture(): the PATH override and the scrub ride the overlay,
  // and the spawn is deadline-bounded with SIGKILL - a hung driver dies
  // loudly instead of wedging the sync spawn past bun-test's cap.
  const proc = capture([process.execPath, driver], { env, timeoutMs: 10_000 });
  return proc.stdout;
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
    const expectedOid = (() => {
      const proc = capture(["git", "-C", root, "rev-parse", "HEAD:present.txt"], {
        env: gitFreeOverlay(),
      });
      if (proc.exitCode !== 0) throw new Error(proc.stderr);
      return proc.stdout.trim();
    })();
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

describe("withoutGitEnv effectiveness", () => {
  const root = makeFixtureRepo();

  test("a poison GIT_DIR genuinely reaches headEntry's git, and the scrub genuinely strips it", () => {
    // The scrub is an ambient process.env mutation, and bun's default
    // spawn env is a process-start snapshot - the shape that kept this
    // file's scrub silently inert until proc.ts handed every spawn live
    // process.env. Both arms are load-bearing: the CONTROL (unscrubbed
    // headEntry throws on the poison) proves the mutation travels to the
    // child at all - without it, a snapshot regression in proc.ts would
    // let the scrubbed arm pass vacuously, the poison never having left
    // this process.
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(tmpdir(), "head-entry-poison-not-a-git-dir");
    try {
      expect(() => headEntry(root, "present.txt")).toThrow(/ls-tree against HEAD failed/);
      const entry = withoutGitEnv(() => headEntry(root, "present.txt"));
      expect(entry.kind).toBe("blob");
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  test("the blob byte-read is handed live process.env, never bun's startup snapshot", () => {
    // The poison arm above dies at ls-tree, so it can never reach the
    // byte read - this pin inspects the spawn itself instead: a marker
    // set AFTER process start must ride the cat-file call's env argument.
    // An absent env (bun's default) would mean the startup snapshot,
    // which no caller scrub can touch - the regression this pins red
    // under a clean environment, where every other test stays green.
    process.env.HEAD_ENTRY_ENV_CANARY = "live";
    const spy = spyOn(Bun, "spawnSync");
    try {
      const entry = withoutGitEnv(() => headEntry(root, "present.txt"));
      expect(entry.kind).toBe("blob");
      const reads = spy.mock.calls.filter((call) => (call[0] as string[]).includes("cat-file"));
      expect(reads.length).toBe(1);
      const env = (reads[0][1] as { env?: Record<string, string | undefined> }).env;
      expect(env?.HEAD_ENTRY_ENV_CANARY).toBe("live");
    } finally {
      spy.mockRestore();
      delete process.env.HEAD_ENTRY_ENV_CANARY;
    }
  });
});
