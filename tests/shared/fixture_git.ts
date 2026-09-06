// git for test fixtures, run under fixture.gitconfig as the global config:
// no detached `maintenance run --auto` (or pre-2.45 `gc --auto`) on either
// side of a local push or after a commit, so a fixture's next command
// never races a repack of the loose objects it is reading. The carrier is
// GIT_CONFIG_GLOBAL because the push client strips GIT_CONFIG_PARAMETERS
// (`-c`) and GIT_CONFIG_COUNT from receive-pack's environment.

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
