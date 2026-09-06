// Scratch fixtures for the migration ladder's tests: git repositories with
// GIT_* env stripped (hook-driven runs export GIT_DIR/GIT_INDEX_FILE,
// which would redirect every git subprocess away from the scratch
// repositories), a "platform" whose build history is a tagged chain of
// commits each carrying chosen rung files, self-contained rung sources,
// and the runner CLI over them. Every directory comes from the calling
// test file's TempDirs handle, so that file's afterAll owns it.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS_DIR } from "../../.github/scripts/sync/run_migrations.ts";
import { boundedSpawnSync } from "./bounded_spawn";
import type { TempDirs } from "./temp_dir";

const RUNNER = join(import.meta.dir, "../../.github/scripts/sync/run_migrations.ts");
const IDENT = ["-c", "user.name=t", "-c", "user.email=t@x"];

export function gitFreeEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

export function git(dir: string, ...args: string[]): string {
  const proc = boundedSpawnSync(["git", "-C", dir, ...args], { env: gitFreeEnv() });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout;
}

/** One build commit of a scratch platform: its tag and the rung files
 * (name -> source) its migrations/ directory carries. */
export interface BuildStep {
  tag: string;
  rungs: Record<string, string>;
}

/** A self-contained rung source: apply writes `.github/<id>.txt` holding
 * the target's two shas and this copy's `stamp` (so a test can tell WHICH
 * build commit's copy ran), stages it, and returns `kind` with `note`.
 * `body` replaces the whole apply body for the malformed-rung cases. */
export function rungSource(
  id: string,
  options: {
    kind?: string;
    note?: { text: string; review: boolean } | null;
    stamp?: string;
    body?: string;
  } = {},
): string {
  const body =
    options.body ??
    [
      `    const path = join(target.dir, ".github", "${id}.txt");`,
      `    writeFileSync(path, \`\${target.oldSha}|\${target.newSha}|${options.stamp ?? ""}\\n\`);`,
      `    Bun.spawnSync(["git", "-C", target.dir, "add", ".github/${id}.txt"]);`,
      `    return { kind: "verdict", verdict: { kind: ${JSON.stringify(options.kind ?? "planted")}, note: ${JSON.stringify(options.note ?? null)} } };`,
    ].join("\n");
  return [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "export default {",
    `  id: ${JSON.stringify(id)},`,
    "  apply(target: { dir: string; oldSha: string | null; newSha: string }) {",
    body,
    "  },",
    "};",
    "",
  ].join("\n");
}

/** The scratch-repository fixtures, every directory drawn from `temp`. */
export function ladderFixtures(temp: TempDirs) {
  /** A one-commit git repository holding `files` plus `.github/keep`
   * (every fleet checkout carries a .github/ directory, and git tracks no
   * empty ones). */
  function repo(files: Record<string, string>): string {
    const dir = temp.dir("ladder-target-");
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github", "keep"), "");
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    git(dir, "init", "-q", "-b", "main");
    git(dir, ...IDENT, "add", "-A");
    git(dir, ...IDENT, "commit", "-qm", "target state");
    return dir;
  }

  /** A scratch platform whose linear build history is `chain`, oldest
   * first, one tagged commit per step; each step's migrations/ holds
   * exactly its rungs (the directory is replaced wholesale, so no step
   * inherits another's files). */
  function platform(chain: BuildStep[]): string {
    const dir = repo({ "copier.yml": "_subdirectory: template\n" });
    for (const step of chain) {
      rmSync(join(dir, MIGRATIONS_DIR), { recursive: true, force: true });
      mkdirSync(join(dir, MIGRATIONS_DIR), { recursive: true });
      for (const [name, source] of Object.entries(step.rungs)) {
        writeFileSync(join(dir, MIGRATIONS_DIR, name), source);
      }
      git(dir, ...IDENT, "add", "-A");
      git(dir, ...IDENT, "commit", "-q", "--allow-empty", "-m", step.tag);
      git(dir, "tag", step.tag);
    }
    return dir;
  }

  /** The runner CLI with OLD_SHA passed VERBATIM (for the runner's own
   * shape guard), or left unset when `oldSha` is undefined. */
  function runLadderWithOldSha(
    platformDir: string,
    targetDir: string,
    oldSha: string | undefined,
    newRef = "new",
  ) {
    const runnerTemp = temp.dir("ladder-temp-");
    const proc = boundedSpawnSync(["bun", RUNNER], {
      env: {
        ...gitFreeEnv(),
        PLATFORM_DIR: platformDir,
        TARGET_DIR: targetDir,
        TARGET_DISPLAY: "Vivswan/demo",
        ...(oldSha === undefined ? {} : { OLD_SHA: oldSha }),
        TARGET_REF: newRef,
        RUNNER_TEMP: runnerTemp,
      },
    });
    return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr, temp: runnerTemp };
  }

  /** The runner CLI over `platformDir`'s tagged history against
   * `targetDir`; `oldRef` "" models a target with no usable base, any
   * other value is resolved to its full sha (the runner takes only that
   * shape, as the sync's resolver hands it over). */
  function runLadder(platformDir: string, targetDir: string, oldRef: string, newRef = "new") {
    const oldSha = oldRef === "" ? "" : git(platformDir, "rev-parse", `${oldRef}^{commit}`).trim();
    return runLadderWithOldSha(platformDir, targetDir, oldSha, newRef);
  }

  return { repo, platform, runLadder, runLadderWithOldSha };
}
