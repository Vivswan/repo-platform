// The producers (publish.ts) and the verifier (rebuild_tree.ts) must stage a composed tree to the
// SAME tree hash, or the sync's provenance proof reads the skew as tampering. Both measured
// divergence vectors are planted at once:
//   an in-tree .gitignore hiding a sibling  -> dropped by a plain `add -A`
//   the parent repo's .git/info/exclude     -> inherited by the producers' scratch worktrees, never seen by the verifier's fresh repo

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageComposedTreeArgv } from "../../.github/scripts/shared/stage_tree.ts";
import { boundedSpawnSync } from "./bounded_spawn";
import { tempDirs } from "./temp_dir";

const temp = tempDirs();

const root = join(import.meta.dir, "../..");

/** The retired producer argv, kept as the divergence proof's subject, never as a fallback. */
const oldProducerArgv = (treeDir: string) => ["git", "-C", treeDir, "add", "-A"];

let fixtures: string;
let hermeticEnv: Record<string, string>;

/** A developer's global or XDG ignore matching a fixture name would false-red the control arm, so
 * every spawn is HANDED this env; the hostile arms plant their vectors explicitly.
 *   GIT_* scrubbed          -> hook-driven runs export GIT_DIR and GIT_INDEX_FILE, which would redirect the fixture repos' git
 *   XDG_CONFIG_HOME pinned  -> GIT_CONFIG_GLOBAL replaces the global config files but not $XDG_CONFIG_HOME/git/ignore and attributes */
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
  const proc = boundedSpawnSync(argv, { env: env ?? hermeticEnv });
  if (proc.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${proc.stderr}`);
  }
  return proc.stdout.trimEnd();
}

/** The hostile .gitignore is the in-tree vector only `--force` covers. */
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

/** The PRODUCER's environment (publish.ts): an orphan worktree of a parent
 * repo, inheriting the parent's .git/info/exclude - planted here (hostile
 * arm) to hide a composed file, the axis a fresh scratch repo can never
 * reproduce. */
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
  return boundedSpawnSync(["git", "-C", dir, "cat-file", "-p", `${tree}:crlf.txt`], { env }).stdout;
}

beforeAll(() => {
  fixtures = temp.dir("stage-tree-");
  writeFileSync(join(fixtures, "empty-gitconfig"), "");
  mkdirSync(join(fixtures, "empty-xdg"));
  hermeticEnv = buildHermeticEnv();
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
    // Under the empty-config pin nothing exists for `-c core.attributesFile=/dev/null` to neutralize
    // (deleting the flag left the rest of this suite green), so this arm supplies a global attributes file.
    //   `* text` in the attributes file  -> rewrites CRLF at add time; the helper must stay immune while the plain-add control is bitten
    //   autocrlf = false in the fixture   -> only the ATTRIBUTES neutralization is under test; the arm below owns autocrlf
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
    // autocrlf=input rewrites CRLF at add time through config alone, which `-c core.attributesFile=/dev/null`
    // does not cover: a config-bearing developer laptop would skew a local verifier against a config-free
    // CI producer.
    //   the vector rides a test-owned GIT_CONFIG_GLOBAL -> autocrlf has no XDG fallback, so under buildHermeticEnv's pins no other scope carries it
    //   planted anywhere else                           -> the arm passes vacuously
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
    // site calls the helper, so a site quietly reverting to a raw `add`
    // argv is the regression this pin makes loud. The provenance rebuild
    // is covered too: a tree that grew an ignore-matching file would make
    // it verify a different tree than production publishes.
    const rawAdd = /"add",\s*"(?:-A|--all)"/g;
    const sites: { rel: string; composed: boolean; allowedPlainAdds?: string[] }[] = [
      { rel: ".github/scripts/build-branches/publish.ts", composed: true },
      { rel: ".github/scripts/shared/rebuild_tree.ts", composed: true },
      // The plain adds stage managed-repo trees whose own ignore rules must
      // keep applying: --force would smuggle ignored files, so these sites
      // must never adopt the helper.
      {
        rel: ".github/scripts/shared/open_automation_pr.ts",
        composed: false,
        allowedPlainAdds: ['["git", "add", "-A"]'],
      },
      {
        rel: ".github/scripts/sync/deliver.ts",
        composed: false,
        allowedPlainAdds: ['git("add", "--all")'],
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
