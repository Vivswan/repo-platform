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
});
