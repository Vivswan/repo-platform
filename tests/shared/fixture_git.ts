// Fixture git under fixture.gitconfig: no detached auto maintenance racing
// the next command's read of loose objects. GIT_CONFIG_GLOBAL is the carrier
// because the push client strips `-c` and GIT_CONFIG_COUNT from receive-pack.

import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";

export const FIXTURE_GITCONFIG = join(import.meta.dir, "fixture.gitconfig");

/** The live process env (test files may mutate it) with the pinned global
 * config; also the base for any script under test that runs git against
 * a fixture. */
export function fixtureGitEnv(): Record<string, string | undefined> {
  return { ...process.env, GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG };
}

/** Runs `git -C cwd ...args` under fixtureGitEnv(), throws on a nonzero
 * exit, and returns stdout without its trailing newline. */
export function fixtureGit(cwd: string, args: string[]): string {
  const proc = boundedSpawnSync(["git", "-C", cwd, ...args], { env: fixtureGitEnv() });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trimEnd();
}
