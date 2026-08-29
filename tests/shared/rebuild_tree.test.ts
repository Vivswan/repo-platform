import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildBranchTree } from "../../.github/scripts/shared/rebuild_tree.ts";

// The helper resolves git against the process cwd and the builder script
// against the SOURCE worktree, so the fixture is a self-contained scratch
// repo carrying a stub branch_tree.ts - the real builder needs the whole
// template tree and would turn this into an integration test.
const STUB_BUILDER = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const get = (flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const dest = get("--dest");
if (!dest) process.exit(2);
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, "content.txt"), "deterministic\\n");
`;

let scratch: string;
let sourceSha: string;
let savedCwd: string;
const savedGitEnv: Record<string, string> = {};

function git(...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", scratch, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

beforeAll(() => {
  // Hook-driven runs export GIT_DIR/GIT_INDEX_FILE, which would redirect
  // the helper's git subprocesses away from the scratch repo; the helper
  // inherits process.env, so scrub it here and restore after.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
      savedGitEnv[key] = process.env[key] as string;
      delete process.env[key];
    }
  }
  scratch = mkdtempSync(join(tmpdir(), "rebuild-tree-"));
  mkdirSync(join(scratch, ".github/scripts/build-branches"), { recursive: true });
  writeFileSync(join(scratch, ".github/scripts/build-branches/branch_tree.ts"), STUB_BUILDER);
  writeFileSync(join(scratch, "package.json"), '{ "name": "fixture", "private": true }\n');
  // A committed lockfile so the helper's --frozen-lockfile install passes.
  Bun.spawnSync(["bun", "install", "--silent"], { cwd: scratch });
  writeFileSync(join(scratch, ".gitignore"), "node_modules/\n");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  sourceSha = git("rev-parse", "HEAD");
  // The helper's git commands run against the process cwd, like the
  // publish/verify callers whose cwd is the checkout.
  savedCwd = process.cwd();
  process.chdir(scratch);
});

afterAll(() => {
  process.chdir(savedCwd);
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedGitEnv)) {
    process.env[key] = value;
  }
});

describe("rebuildBranchTree", () => {
  test("the same source rebuilds to the same tree hash", () => {
    const dirs = (name: string) => ({
      srcDir: join(scratch, `work-${name}`, "src"),
      treeDir: join(scratch, `work-${name}`, "tree"),
    });
    const first = rebuildBranchTree({ sourceSha, ...dirs("a") });
    const second = rebuildBranchTree({ sourceSha, ...dirs("b") });
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(second).toBe(first);
    for (const name of ["a", "b"]) {
      git("worktree", "remove", "--force", join(scratch, `work-${name}`, "src"));
    }
  });

  test("an unresolvable source throws instead of returning a hash", () => {
    expect(() =>
      rebuildBranchTree({
        sourceSha: "0123456789012345678901234567890123456789",
        srcDir: join(scratch, "work-bad", "src"),
        treeDir: join(scratch, "work-bad", "tree"),
      }),
    ).toThrow(/command failed/);
  });

  test("a step past REBUILD_STEP_TIMEOUT_MS throws the deadline instead of hanging", () => {
    // The knob is read at call time, so setting it here reaches the
    // helper in-process; 1 ms sits below any real fork+exec, so the
    // FIRST step (git worktree add) is the one that expires - and the
    // thrown message must NAME it, pinning step()'s own bound: without
    // that pin an unbounded step() would still satisfy a bare
    // "timed out" match via stepCapture's write-tree deadline at the
    // end. Without the bound, a wedged install runs unbounded under
    // wait_for_build's 15-minute headroom and dies as a runner-level
    // job kill instead of degrading to the warn path.
    process.env.REBUILD_STEP_TIMEOUT_MS = "1";
    try {
      expect(() =>
        rebuildBranchTree({
          sourceSha,
          srcDir: join(scratch, "work-slow", "src"),
          treeDir: join(scratch, "work-slow", "tree"),
        }),
      ).toThrow(/timed out after 1ms: git worktree add/);
    } finally {
      delete process.env.REBUILD_STEP_TIMEOUT_MS;
      // The SIGKILLed worktree add may have half-registered its worktree.
      git("worktree", "prune");
    }
  });

  test("a malformed REBUILD_STEP_TIMEOUT_MS fails loud instead of disabling the bound", () => {
    // Number("") is 0 and a spawnSync timeout of 0 means unbounded, so
    // an empty knob would silently remove the deadline it exists to set.
    // The absent scratch dir pins that the throw came before the first
    // step ran (worktree add is what creates it).
    process.env.REBUILD_STEP_TIMEOUT_MS = "";
    try {
      expect(() =>
        rebuildBranchTree({
          sourceSha,
          srcDir: join(scratch, "work-badknob", "src"),
          treeDir: join(scratch, "work-badknob", "tree"),
        }),
      ).toThrow(/REBUILD_STEP_TIMEOUT_MS must be a positive integer/);
    } finally {
      delete process.env.REBUILD_STEP_TIMEOUT_MS;
    }
    expect(existsSync(join(scratch, "work-badknob"))).toBe(false);
  });

  test("a credential-shaped source is rejected before any child can echo it", () => {
    // The steps run with inherited stdio, so a smuggled argv value would
    // hit the log raw via git's own error text; the boundary validation
    // must throw a value-free message without spawning anything.
    let message = "";
    try {
      rebuildBranchTree({
        sourceSha: "https://x-access-token:ghp_SENTINEL@github.com/o/r.git",
        srcDir: join(scratch, "work-cred", "src"),
        treeDir: join(scratch, "work-cred", "tree"),
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe("rebuildBranchTree: sourceSha must be a full 40-hex commit sha");
    expect(existsSync(join(scratch, "work-cred"))).toBe(false);
  });

  test("hostile ignore and attribute config - in-tree AND machine-global - cannot skew the hash", () => {
    // The scratch staging feeds both the provenance tree proof and
    // wait_for_build's freshness compare, so a silent staging skew turns
    // into a false tamper accusation or a burned 40-minute wait. Three
    // measured skew vectors, all planted at once: a .gitignore INSIDE
    // the composed tree hiding a sibling (only `add --force` covers it -
    // an excludesFile override does not), a machine-global
    // core.excludesFile hiding another file, and a machine-global
    // core.attributesFile whose `* text` filter rewrites a CRLF blob at
    // add time. The hash must not move, and the hidden files must be IN
    // the tree.
    const hostileBuilder = `${STUB_BUILDER}
writeFileSync(join(dest, "ignored.txt"), "must be staged\\n");
writeFileSync(join(dest, "crlf.txt"), "windows line\\r\\n");
writeFileSync(join(dest, ".gitignore"), "ignored.txt\\n");
`;
    writeFileSync(join(scratch, ".github/scripts/build-branches/branch_tree.ts"), hostileBuilder);
    // Stage only the builder: earlier tests leave scratch tree repos
    // (work-*/tree) lying around, and a bare add -A would trip over them.
    git("add", ".github/scripts/build-branches/branch_tree.ts");
    git("commit", "-qm", "hostile fixture");
    const hostileSha = git("rev-parse", "HEAD");
    const dirs = (name: string) => ({
      srcDir: join(scratch, `work-${name}`, "src"),
      treeDir: join(scratch, `work-${name}`, "tree"),
    });
    const clean = rebuildBranchTree({ sourceSha: hostileSha, ...dirs("clean") });
    const cfg = mkdtempSync(join(tmpdir(), "hostile-git-"));
    writeFileSync(join(cfg, "ignore"), "content.txt\n");
    writeFileSync(join(cfg, "attributes"), "* text\n");
    writeFileSync(
      join(cfg, "config"),
      `[core]\n\texcludesFile = ${join(cfg, "ignore")}\n\tattributesFile = ${join(cfg, "attributes")}\n`,
    );
    // GIT_CONFIG_GLOBAL replaces the whole global scope (~/.gitconfig AND
    // the XDG fallback), so the hostile file is the one global config the
    // helper's subprocesses see.
    process.env.GIT_CONFIG_GLOBAL = join(cfg, "config");
    let hostile: string;
    try {
      hostile = rebuildBranchTree({ sourceSha: hostileSha, ...dirs("hostile") });
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL;
    }
    expect(hostile).toBe(clean);
    const listing = Bun.spawnSync(
      ["git", "-C", join(scratch, "work-hostile", "tree"), "ls-tree", "--name-only", hostile],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(listing.exitCode).toBe(0);
    const names = listing.stdout.toString();
    expect(names).toContain("ignored.txt");
    expect(names).toContain("content.txt");
    expect(names).toContain("crlf.txt");
    for (const name of ["clean", "hostile"]) {
      git("worktree", "remove", "--force", join(scratch, `work-${name}`, "src"));
    }
    rmSync(cfg, { recursive: true, force: true });
  });
});
