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

function run(argv: string[], env?: Record<string, string>): string {
  const proc = Bun.spawnSync(argv, {
    env: env ?? hermeticEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
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

const CRLF = "line one\r\nline two\r\n";

/** Stage a one-file CRLF tree with `argv` under `env` and return the
 * STAGED blob's bytes - the subject both blob-rewrite arms below read,
 * each under its own hostile machine-global config fixture. */
function stagedBlob(
  name: string,
  argv: (treeDir: string) => string[],
  env: Record<string, string>,
): string {
  const dir = join(fixtures, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "crlf.txt"), CRLF);
  run(["git", "-C", dir, "init", "--quiet"], env);
  run(argv(dir), env);
  const tree = run(["git", "-C", dir, "write-tree"], env);
  return Bun.spawnSync(["git", "-C", dir, "cat-file", "-p", `${tree}:crlf.txt`], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  }).stdout.toString();
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

  test("the attributesFile override is ARMED: a global attributes rewrite cannot touch the helper's staged bytes", () => {
    // The empty-config pin above means no attributes file ever exists
    // for `-c core.attributesFile=/dev/null` to neutralize - deleting
    // the flag left the rest of this suite green. So this arm points
    // the global scope at a test-owned config whose attributes file
    // carries a staging-visible rewrite (`* text` normalizes CRLF to LF
    // at add time), and requires the helper's staging IMMUNE while a
    // plain-add control IS bitten - the control proving the fixture
    // actually rewrites, so immunity is the flag's doing. autocrlf is
    // pinned false in the fixture config so the two normalization
    // mechanisms cannot confound: this arm discriminates the
    // ATTRIBUTES neutralization alone (the arm below owns autocrlf).
    const attributes = join(fixtures, "attr-rules");
    writeFileSync(attributes, "* text\n");
    const gitconfig = join(fixtures, "attr-gitconfig");
    writeFileSync(gitconfig, `[core]\n\tattributesFile = ${attributes}\n\tautocrlf = false\n`);
    const attrEnv = { ...hermeticEnv, GIT_CONFIG_GLOBAL: gitconfig };
    expect(stagedBlob("attr-helper", stageComposedTreeArgv, attrEnv)).toBe(CRLF);
    expect(stagedBlob("attr-control", oldProducerArgv, attrEnv)).toBe(
      CRLF.replaceAll("\r\n", "\n"),
    );
  });

  test("the autocrlf override is ARMED: a machine-global core.autocrlf cannot touch the helper's staged bytes", () => {
    // autocrlf=input rewrites CRLF at add time through CONFIG alone -
    // no attributes file anywhere - so `-c core.attributesFile=/dev/null`
    // does not cover it: a config-bearing machine (a developer laptop
    // with dotfiles) would skew a local verifier against a config-free
    // CI producer, the exact class the helper exists to prevent. The
    // vector MUST ride a test-owned GIT_CONFIG_GLOBAL fixture file:
    // unlike attributes (whose XDG fallback survives GIT_CONFIG_GLOBAL),
    // autocrlf is a pure config key with no fallback path, so under
    // buildHermeticEnv's pins this fixture is the only scope that can
    // carry a live vector - planted anywhere else the arm would pass
    // with and without the override, vacuously. No attributesFile is
    // set here, so this arm discriminates the AUTOCRLF neutralization
    // alone.
    const gitconfig = join(fixtures, "autocrlf-gitconfig");
    writeFileSync(gitconfig, "[core]\n\tautocrlf = input\n");
    const crlfEnv = { ...hermeticEnv, GIT_CONFIG_GLOBAL: gitconfig };
    expect(stagedBlob("autocrlf-helper", stageComposedTreeArgv, crlfEnv)).toBe(CRLF);
    expect(stagedBlob("autocrlf-control", oldProducerArgv, crlfEnv)).toBe(
      CRLF.replaceAll("\r\n", "\n"),
    );
  });

  test("every composed-tree staging site stages through the ONE shared argv", () => {
    // The agreement holds BY CONSTRUCTION only while every composed-tree
    // site calls the helper: a site quietly reverting to a raw `add`
    // argv is the regression this pin makes loud. Beyond the
    // producer/verifier trio, the pin covers the sites whose staged tree
    // only has to EQUAL the published one (CI's smoke source, the golden
    // renders, the sync rehearsal's synthetic build): none feeds the
    // provenance hash, but a composed tree that ever grew an
    // ignore-matching file would make them validate a DIFFERENT tree
    // than production publishes.
    //
    // The matcher sees BOTH raw spellings (`-A` and `--all`) so a
    // spelling switch cannot dodge it, and the deliberately-raw sites
    // are enumerated with their exact calls (one allowedPlainAdds entry
    // per occurrence) instead of left unscanned - pinned to the call, so
    // a swap (helper on the exempt site, raw add back on a composed one)
    // cannot false-pass. They stage managed-repo trees whose own ignore
    // rules must keep applying, so they stay plain AND must not adopt
    // the helper (--force would smuggle ignored files): rehearse.ts's
    // TARGET repo post-update staging (the would-be PR diff),
    // open_automation_pr.ts's working-tree regeneration outputs, and
    // commit_push.ts's rendered target repo.
    const rawAdd = /"add",\s*"(?:-A|--all)"/g;
    const sites: { rel: string; composed: boolean; allowedPlainAdds?: string[] }[] = [
      { rel: ".github/scripts/build-branches/build_pending.ts", composed: true },
      { rel: ".github/scripts/build-branches/publish.ts", composed: true },
      { rel: ".github/scripts/shared/rebuild_tree.ts", composed: true },
      { rel: ".github/scripts/ci/smoke_generate.ts", composed: true },
      { rel: "scripts/render_goldens.ts", composed: true },
      {
        rel: ".github/scripts/sync/rehearse.ts",
        composed: true,
        allowedPlainAdds: ['"-C", targetDir, "add", "-A"'],
      },
      {
        rel: ".github/scripts/shared/open_automation_pr.ts",
        composed: false,
        allowedPlainAdds: ['["git", "add", "-A"]'],
      },
      {
        rel: ".github/scripts/sync/commit_push.ts",
        composed: false,
        allowedPlainAdds: ['git("add", "--all")', 'git("add", "--all")'],
      },
    ];
    for (const { rel, composed, allowedPlainAdds = [] } of sites) {
      const text = readFileSync(join(root, rel), "utf8");
      if (composed) {
        expect(text).toContain("stageComposedTreeArgv(");
      } else {
        expect(text).not.toContain("stageComposedTreeArgv(");
      }
      expect(text.match(rawAdd) ?? []).toHaveLength(allowedPlainAdds.length);
      // Per-snippet occurrence counts, not bare containment: with two
      // identical exempt calls, containment alone would let one of them
      // drift to another raw spelling while the other still satisfies it.
      const expected = new Map<string, number>();
      for (const allowed of allowedPlainAdds) {
        expected.set(allowed, (expected.get(allowed) ?? 0) + 1);
      }
      for (const [allowed, count] of expected) {
        expect(text.split(allowed)).toHaveLength(count + 1);
      }
    }
  });
});
