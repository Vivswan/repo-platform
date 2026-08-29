import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../../.github/scripts/shared/proc.ts";
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

/** Explicit env OVERLAY deleting every GIT_* variable, handed to this
 * file's own spawns at the call site (the repo's adopted style for tests
 * that scrub - ambient process.env mutation around a spawn stays fragile
 * under parallel test execution). The overlay shape: capture() MERGES
 * options.env over live process.env, so the scrub must arrive as
 * undefined-VALUED entries - bun then omits the keys - never as a
 * filtered env copy, which would merge over the live base without
 * deleting anything. The same shape works spread into a raw spawn's
 * replacement env (bun omits undefined values there too). */
function gitFreeOverlay(): Record<string, string | undefined> {
  const overlay: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) overlay[key] = undefined;
  }
  return overlay;
}

function git(...args: string[]): string {
  // Through capture(): explicit scrub overlay, and the spawn stays
  // bounded (proc.ts's default hang bound) - a raw sync spawn blocks the
  // event loop, so bun-test's per-test cap could never interrupt a hung
  // child.
  const proc = capture(["git", "-C", scratch, ...args], { env: gitFreeOverlay() });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  }
  return proc.stdout.trim();
}

beforeAll(() => {
  // Hook-driven runs export GIT_DIR/GIT_INDEX_FILE, which would redirect
  // git subprocesses away from the scratch repo. rebuildBranchTree takes
  // no env parameter, so this ambient scrub is the one channel that can
  // clean ITS children - and it reaches them only because every spawn
  // under the helper is handed live process.env (proc.ts's contract; the
  // helper's inherited-stdio steps hand it explicitly too - bun's own
  // default is a process-start snapshot that kept this scrub silently
  // inert; the poison-GIT_DIR test below pins that it bites now). This
  // file's own spawns take the gitFreeOverlay() scrub explicitly instead.
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
  // Through capture(): explicit scrub overlay and a bounded spawn.
  capture(["bun", "install", "--silent"], { cwd: scratch, env: gitFreeOverlay() });
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

  test("a hostile GIT_DIR mutation genuinely reaches the helper's children, and deleting it clears them", () => {
    // beforeAll's scrub relies on process.env mutations reaching the
    // helper's spawned children - the exact channel bun's default
    // snapshot env silently severed. CONTROL first: a poison GIT_DIR
    // must break the helper (the first step's git runs against the
    // poison instead of the scratch repo). Then the deletion arm:
    // removing the poison must clear the child again - beforeAll's scrub
    // is this same delete. On a snapshot regression the control arm
    // fails loudly instead of the scrub going quietly inert.
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(scratch, "poison-not-a-git-dir");
    try {
      expect(() =>
        rebuildBranchTree({
          sourceSha,
          srcDir: join(scratch, "work-poison", "src"),
          treeDir: join(scratch, "work-poison", "tree"),
        }),
      ).toThrow(/command failed/);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    const hash = rebuildBranchTree({
      sourceSha,
      srcDir: join(scratch, "work-unpoisoned", "src"),
      treeDir: join(scratch, "work-unpoisoned", "tree"),
    });
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    // The poison arm died at its FIRST step (git worktree add ran against
    // the poison, not the scratch repo), so it registered nothing to
    // remove - prune any half-registration; only the unpoisoned rebuild
    // holds a real worktree.
    git("worktree", "prune");
    git("worktree", "remove", "--force", join(scratch, "work-unpoisoned", "src"));
  });

  test("every helper spawn is handed live process.env, never bun's startup snapshot", () => {
    // The poison control above proves delivery end-to-end, but a partial
    // regression - ONE spawn site dropping its env argument - could hide
    // behind whichever site still fails loudly first. This pin inspects
    // every spawn the helper makes: a marker set AFTER process start
    // must ride each call's env argument (an absent env means bun's
    // startup snapshot, which no caller scrub can touch).
    process.env.REBUILD_ENV_CANARY = "live";
    const spy = spyOn(Bun, "spawnSync");
    try {
      const hash = rebuildBranchTree({
        sourceSha,
        srcDir: join(scratch, "work-envpin", "src"),
        treeDir: join(scratch, "work-envpin", "tree"),
      });
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      for (const call of spy.mock.calls) {
        const env = (call[1] as { env?: Record<string, string | undefined> } | undefined)?.env;
        expect(env?.REBUILD_ENV_CANARY).toBe("live");
      }
    } finally {
      spy.mockRestore();
      delete process.env.REBUILD_ENV_CANARY;
    }
    git("worktree", "remove", "--force", join(scratch, "work-envpin", "src"));
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
    const cfg = mkdtempSync(join(tmpdir(), "hostile-git-"));
    writeFileSync(join(cfg, "ignore"), "content.txt\n");
    writeFileSync(join(cfg, "attributes"), "* text\n");
    writeFileSync(
      join(cfg, "config"),
      `[core]\n\texcludesFile = ${join(cfg, "ignore")}\n\tattributesFile = ${join(cfg, "attributes")}\n`,
    );
    // BOTH arms run in DRIVER subprocesses with pinned startup
    // environments - the shape that first made this arm genuinely
    // hostile: as an in-process mutation the config never reached the
    // helper's then-snapshot-env `git add`, the exact spawn the
    // excludesFile must fail to skew. Drivers also keep the arms
    // SYMMETRIC: both startup envs are pinned like stage_tree.test.ts's
    // buildHermeticEnv and differ ONLY in which file the global scope
    // reads, so a hash move is attributable to the hostile config alone
    // - unpinned, the machine's real global config leaks into the clean
    // arm asymmetrically (a developer core.autocrlf=input was measured
    // doing exactly that).
    writeFileSync(join(cfg, "empty-gitconfig"), "");
    mkdirSync(join(cfg, "empty-xdg"));
    const baseEnv = {
      ...process.env,
      ...gitFreeOverlay(),
      GIT_CONFIG_GLOBAL: join(cfg, "empty-gitconfig"),
      GIT_CONFIG_SYSTEM: join(cfg, "empty-gitconfig"),
      XDG_CONFIG_HOME: join(cfg, "empty-xdg"),
    };
    const hostileEnv = { ...baseEnv, GIT_CONFIG_GLOBAL: join(cfg, "config") };
    // Control: under the hostile env git genuinely ignores content.txt
    // (exit 0) - without a live vector the agreement assertions pass
    // vacuously. The overlay entries already ride hostileEnv, so capture's
    // merge delivers exactly the pinned scopes.
    expect(
      capture(["git", "-C", scratch, "check-ignore", "-q", "content.txt"], {
        env: hostileEnv,
      }).exitCode,
    ).toBe(0);
    const driver = join(cfg, "driver.ts");
    const helper = join(import.meta.dir, "../../.github/scripts/shared/rebuild_tree.ts");
    writeFileSync(
      driver,
      [
        `import { rebuildBranchTree } from ${JSON.stringify(helper)};`,
        "const [sourceSha, srcDir, treeDir] = process.argv.slice(2);",
        "console.log(rebuildBranchTree({ sourceSha, srcDir, treeDir }));",
        "",
      ].join("\n"),
    );
    const rebuildInDriver = (name: string, env: Record<string, string | undefined>): string => {
      const { srcDir, treeDir } = dirs(name);
      // Through capture(): the env carries a full process.env copy plus
      // the pinned scopes, so the merge hands the driver exactly that
      // startup environment - deadline-bounded with SIGKILL, so a hung
      // rebuild dies loudly inside the test budget.
      const run = capture([process.execPath, driver, hostileSha, srcDir, treeDir], {
        cwd: scratch,
        env,
        timeoutMs: 10_000,
      });
      if (run.exitCode !== 0) throw new Error(`${name} driver failed: ${run.stderr}`);
      return run.stdout.trim();
    };
    const clean = rebuildInDriver("clean", baseEnv);
    const hostile = rebuildInDriver("hostile", hostileEnv);
    expect(hostile).toBe(clean);
    const listing = capture(
      ["git", "-C", join(scratch, "work-hostile", "tree"), "ls-tree", "--name-only", hostile],
      { env: gitFreeOverlay() },
    );
    expect(listing.exitCode).toBe(0);
    const names = listing.stdout;
    expect(names).toContain("ignored.txt");
    expect(names).toContain("content.txt");
    expect(names).toContain("crlf.txt");
    for (const name of ["clean", "hostile"]) {
      git("worktree", "remove", "--force", join(scratch, `work-${name}`, "src"));
    }
    rmSync(cfg, { recursive: true, force: true });
  });
});
