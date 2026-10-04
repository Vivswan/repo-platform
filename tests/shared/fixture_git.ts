// Fixture git under fixture.gitconfig: no detached auto maintenance racing
// the next command's read of loose objects. GIT_CONFIG_GLOBAL is the carrier
// because the push client strips `-c` and GIT_CONFIG_COUNT from receive-pack.

import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";

export const FIXTURE_GITCONFIG = join(import.meta.dir, "fixture.gitconfig");

/** Command-scope config (`git -c`, GIT_CONFIG_COUNT triples) outranks the
 * global file, so an ambient one could re-enable maintenance. A git hook's
 * GIT_DIR, GIT_INDEX_FILE, and GIT_WORK_TREE would point a scratch repository's
 * every git at the real one (a leaked GIT_DIR once rewrote this repository's
 * config to bare). */
const AMBIENT_GIT = /^GIT_(CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)|DIR|INDEX_FILE|WORK_TREE)$/;

/** Read at call time because test files mutate process.env; also the env
 * for any script under test that runs git against a fixture. */
export function fixtureGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!AMBIENT_GIT.test(key)) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = FIXTURE_GITCONFIG;
  return env;
}

export function fixtureGit(cwd: string, args: string[]): string {
  const proc = boundedSpawnSync(["git", "-C", cwd, ...args], { env: fixtureGitEnv() });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trimEnd();
}
