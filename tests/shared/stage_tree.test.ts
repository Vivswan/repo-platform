// The staging-agreement contract stage_tree.ts owns: the producers
// (build_pending.ts, publish.ts) and the verifier (rebuild_tree.ts) must
// stage a composed tree to the SAME tree hash, or the sync's provenance
// proof reads the skew as tampering and the freshness slow path reads
// "not fresh" forever. Proven against real git with the two measured
// divergence vectors planted at once:
//   - an in-tree .gitignore hiding a sibling (the vector that diverged
//     the old plain `add -A` producer form from the hermetic verifier);
//   - a parent-repo .git/info/exclude, which the producers' /tmp
//     worktrees inherit while the verifier's fresh scratch repo never
//     sees it (the second skew axis).
// Plus a CONTROL arm: on a tree no ignore rule touches, the hermetic
// argv stages exactly what plain `add -A` staged - the equivalence that
// makes the producers' adoption behavior-preserving for every composed
// tree shipped today (publish.ts's skip guard and stamp recovery see
// the same staged diff).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageComposedTreeArgv } from "../../.github/scripts/shared/stage_tree.ts";

const root = join(import.meta.dir, "../..");

/** The staging argv the producers used before the unification - kept
 * here as the divergence proof's subject, never as a fallback. */
const oldProducerArgv = (treeDir: string) => ["git", "-C", treeDir, "add", "-A"];

let fixtures: string;
let hermeticEnv: Record<string, string>;

/** Every spawn gets this explicit env (Bun.spawnSync must be HANDED the
 * env - the pins are inert as process.env mutations): GIT_* scrubbed
 * (hook-driven runs export GIT_DIR/GIT_INDEX_FILE, which would redirect
 * the fixture repos' git subprocesses), the global and system config
 * scopes pinned to a known-empty file, and XDG_CONFIG_HOME pinned to an
 * empty fixture dir (GIT_CONFIG_GLOBAL replaces the global CONFIG files
 * but not the default $XDG_CONFIG_HOME/git/ignore and attributes paths,
 * which apply even with the keys unset): a developer machine's global
 * or XDG ignore matching a fixture name would false-red the control arm
 * (the old form would drop a file the premise says nothing ignores).
 * The hostile arms plant their vectors explicitly, so pinning loses
 * nothing. Same pattern as tests/sync/normalize_src.test.ts's
 * gitFreeEnv. */
function buildHermeticEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = join(fixtures, "empty-gitconfig");
  env.GIT_CONFIG_SYSTEM = join(fixtures, "empty-gitconfig");
  env.XDG_CONFIG_HOME = join(fixtures, "empty-xdg");
  return env;
}

function run(argv: string[], cwd?: string): string {
  const proc = Bun.spawnSync(argv, { cwd, env: hermeticEnv, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trimEnd();
}

/** The composed-tree bytes, written identically for every path: content
 * every tree has, plus (hostile) a sibling-hiding .gitignore - the
 * in-tree vector only `--force` covers. */
function writeComposedFiles(dir: string, hostile: boolean): void {
  writeFileSync(join(dir, "content.txt"), "deterministic\n");
  if (hostile) {
    writeFileSync(join(dir, "hidden.txt"), "must be staged\n");
    writeFileSync(join(dir, ".gitignore"), "hidden.txt\n");
  }
}

/** The VERIFIER's environment (rebuild_tree.ts): a fresh scratch repo
 * holding only the composed files - no parent config, no info/exclude. */
function verifierHash(name: string, hostile: boolean): string {
  const dir = join(fixtures, name);
  mkdirSync(dir, { recursive: true });
  writeComposedFiles(dir, hostile);
  run(["git", "-C", dir, "init", "--quiet"]);
  run(stageComposedTreeArgv(dir));
  return run(["git", "-C", dir, "write-tree"]);
}

/** The PRODUCERS' environment (build_pending.ts, publish.ts): an orphan
 * worktree of a parent repo, inheriting the parent's .git/info/exclude -
 * planted here (hostile arm) to hide a composed file, the axis a fresh
 * scratch repo can never reproduce. Stages with `argv` and returns the
 * worktree index's tree hash. */
function producerHash(options: {
  name: string;
  hostile: boolean;
  argv: (treeDir: string) => string[];
}): string {
  const { name, hostile, argv } = options;
  const parent = join(fixtures, `${name}-parent`);
  mkdirSync(parent, { recursive: true });
  run(["git", "-C", parent, "init", "--quiet", "-b", "main"]);
  run(["git", "-C", parent, "config", "user.name", "t"]);
  run(["git", "-C", parent, "config", "user.email", "t@t.test"]);
  writeFileSync(join(parent, "repo.txt"), "parent repo\n");
  run(["git", "-C", parent, "add", "-A"]);
  run(["git", "-C", parent, "commit", "--quiet", "-m", "parent"]);
  if (hostile) {
    mkdirSync(join(parent, ".git/info"), { recursive: true });
    writeFileSync(join(parent, ".git/info/exclude"), "content.txt\n");
  }
  const pend = join(fixtures, `${name}-pend`);
  run(["git", "-C", parent, "worktree", "add", "--quiet", "--detach", pend, "HEAD"]);
  run(["git", "-C", pend, "switch", "--quiet", "--orphan", "pending"]);
  writeComposedFiles(pend, hostile);
  run(argv(pend));
  return run(["git", "-C", pend, "write-tree"]);
}

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "stage-tree-"));
  writeFileSync(join(fixtures, "empty-gitconfig"), "");
  mkdirSync(join(fixtures, "empty-xdg"));
  hermeticEnv = buildHermeticEnv();
});

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

describe("stageComposedTreeArgv", () => {
  test("producer and verifier hash a hostile tree identically, and the hidden files are IN it", () => {
    const verifier = verifierHash("agree-verify", true);
    const producer = producerHash({
      name: "agree",
      hostile: true,
      argv: stageComposedTreeArgv,
    });
    expect(producer).toBe(verifier);
    const names = run([
      "git",
      "-C",
      join(fixtures, "agree-pend"),
      "ls-tree",
      "-r",
      "--name-only",
      producer,
    ]);
    expect(names).toContain("hidden.txt");
    expect(names).toContain("content.txt");
    expect(names).toContain(".gitignore");
  });

  test("the retired plain `add -A` producer form DIVERGES on the same hostile tree", () => {
    // The divergence class this module closes, kept live: the old form
    // drops hidden.txt (in-tree .gitignore) and content.txt (the parent
    // repo's info/exclude, inherited by the producer worktree), so the
    // published tree could never match the verifier's rebuild.
    const verifier = verifierHash("diverge-verify", true);
    const producer = producerHash({ name: "diverge", hostile: true, argv: oldProducerArgv });
    expect(producer).not.toBe(verifier);
    const names = run([
      "git",
      "-C",
      join(fixtures, "diverge-pend"),
      "ls-tree",
      "-r",
      "--name-only",
      producer,
    ]);
    expect(names).not.toContain("hidden.txt");
    expect(names).not.toContain("content.txt");
  });

  test("CONTROL: on a tree no ignore rule touches, the hermetic argv stages exactly what `add -A` did", () => {
    // `add -A --force` differs from plain `add -A` only when an ignore
    // rule would exclude something, and the attributesFile override
    // only bites where a global attributes file would rewrite blobs
    // (none here - the global scope is pinned empty above). This is the
    // equivalence that keeps publish.ts's skip guard and stamp-recovery
    // decisions byte-identical for every composed tree shipped today.
    const viaHelper = producerHash({
      name: "control-new",
      hostile: false,
      argv: stageComposedTreeArgv,
    });
    const viaOldForm = producerHash({ name: "control-old", hostile: false, argv: oldProducerArgv });
    expect(viaHelper).toBe(viaOldForm);
    expect(viaHelper).toBe(verifierHash("control-verify", false));
  });

  test("all three staging sites stage through the ONE shared argv", () => {
    // The agreement holds BY CONSTRUCTION only while every site calls
    // the helper: a site quietly reverting to a raw `add` argv is the
    // regression this pin makes loud.
    for (const rel of [
      ".github/scripts/build-branches/build_pending.ts",
      ".github/scripts/build-branches/publish.ts",
      ".github/scripts/shared/rebuild_tree.ts",
    ]) {
      const text = readFileSync(join(root, rel), "utf8");
      expect(text).toContain("stageComposedTreeArgv(");
      expect(text).not.toMatch(/"add",\s*"-A"/);
    }
  });
});
// throwaway dogfood commit for task #32 - this branch never merges (second push: forces the copilot-owed wait path)
