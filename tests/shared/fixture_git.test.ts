// GIT_TRACE=1 names every child git spawns, so the maintenance spawn
// itself is the reading, not its racy effect on the object store. The
// control runs under git's defaults (empty global and system config), not
// the developer's own, which could already disable maintenance.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "./fixture_git";
import { tempDirs } from "./temp_dir";

const temp = tempDirs();
const MAINTENANCE_SPAWN = /run_command: .*git (?:maintenance run|gc) --auto/;

/** Runs `git -C cwd ...args` traced under the pins or under git's
 * defaults and returns the trace. */
function traced(cwd: string, pinned: boolean, args: string[]): string {
  const empty = join(temp.dir("fixture-git-defaults-"), "empty-gitconfig");
  writeFileSync(empty, "");
  const env = pinned
    ? fixtureGitEnv()
    : { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty };
  const proc = boundedSpawnSync(["git", "-C", cwd, ...args], { env: { ...env, GIT_TRACE: "1" } });
  expect(proc.exitCode).toBe(0);
  return proc.stderr;
}

/** A bare origin plus a work clone with one staged file, committed when
 * the scenario needs something to push. */
function originAndWork(committed: boolean): string {
  const root = temp.dir("fixture-git-");
  const origin = join(root, "origin.git");
  fixtureGit(root, ["init", "-q", "--bare", "-b", "main", "origin.git"]);
  const work = join(root, "work");
  mkdirSync(work);
  fixtureGit(work, ["init", "-q", "-b", "main"]);
  fixtureGit(work, ["config", "user.name", "t"]);
  fixtureGit(work, ["config", "user.email", "t@x.test"]);
  fixtureGit(work, ["remote", "add", "origin", origin]);
  writeFileSync(join(work, "a.txt"), "a\n");
  fixtureGit(work, ["add", "-A"]);
  if (committed) fixtureGit(work, ["commit", "-q", "-m", "a"]);
  return work;
}

describe("fixtureGit", () => {
  test.each([
    {
      side: "commit (client-side auto maintenance)",
      args: ["commit", "-q", "-m", "a"],
      committed: false,
    },
    {
      side: "push into a local bare origin (receive-pack's auto gc)",
      args: ["push", "-q", "origin", "main"],
      committed: true,
    },
  ])(
    "$side spawns no maintenance under the pins; the git-defaults control spawns it",
    ({ args, committed }) => {
      expect(traced(originAndWork(committed), true, args)).not.toMatch(MAINTENANCE_SPAWN);
      expect(traced(originAndWork(committed), false, args)).toMatch(MAINTENANCE_SPAWN);
    },
  );

  test("a failing command throws with git's stderr; a passing one returns trimmed stdout", () => {
    const work = originAndWork(true);
    expect(() => fixtureGit(work, ["rev-parse", "--verify", "no-such-ref"])).toThrow(
      /rev-parse --verify no-such-ref failed: fatal: Needed a single revision/,
    );
    expect(fixtureGit(work, ["show", "-s", "--format=%s", "HEAD"])).toBe("a");
  });
});
