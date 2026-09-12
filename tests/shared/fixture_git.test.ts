// GIT_TRACE=1 names every child git spawns, so the spawn itself is the reading;
// the control runs under git's defaults, not the developer's config.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";
import { FIXTURE_GITCONFIG, fixtureGit, fixtureGitEnv } from "./fixture_git";
import { tempDirs } from "./temp_dir";

const temp = tempDirs();
const MAINTENANCE_SPAWN = /run_command: .*git (?:maintenance run|gc) --auto/;

function traced(cwd: string, env: Record<string, string | undefined>, args: string[]): string {
  const proc = boundedSpawnSync(["git", "-C", cwd, ...args], { env: { ...env, GIT_TRACE: "1" } });
  expect(proc.exitCode).toBe(0);
  return proc.stderr;
}

function defaultsEnv(): Record<string, string | undefined> {
  const empty = join(temp.dir("fixture-git-defaults-"), "empty-gitconfig");
  writeFileSync(empty, "");
  return { ...fixtureGitEnv(), GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty };
}

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

// GIT_CONFIG_SYSTEM stays: a supported ambient variable that cannot outrank the global.
const AMBIENT = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "true",
  GIT_CONFIG_PARAMETERS: "'maintenance.auto=true'",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

describe("fixtureGit", () => {
  afterEach(() => {
    for (const key of Object.keys(AMBIENT)) delete process.env[key];
  });

  test.each<{ side: string; args: string[]; committed: boolean }>([
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
      expect(traced(originAndWork(committed), fixtureGitEnv(), args)).not.toMatch(
        MAINTENANCE_SPAWN,
      );
      expect(traced(originAndWork(committed), defaultsEnv(), args)).toMatch(MAINTENANCE_SPAWN);
    },
  );

  test("an ambient GIT_CONFIG_COUNT triple re-enabling maintenance is scrubbed from the fixture env", () => {
    Object.assign(process.env, AMBIENT);
    const unscrubbed = { ...process.env, GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG };
    expect(traced(originAndWork(false), unscrubbed, ["commit", "-q", "-m", "a"])).toMatch(
      MAINTENANCE_SPAWN,
    );
    expect(traced(originAndWork(false), fixtureGitEnv(), ["commit", "-q", "-m", "a"])).not.toMatch(
      MAINTENANCE_SPAWN,
    );
    const env = fixtureGitEnv();
    expect(
      Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("GIT_CONFIG_"))),
    ).toEqual({
      GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG,
      GIT_CONFIG_SYSTEM: "/dev/null",
    });
  });

  test("a failing command throws with git's stderr; a passing one returns trimmed stdout", () => {
    const work = originAndWork(true);
    expect(() => fixtureGit(work, ["rev-parse", "--verify", "no-such-ref"])).toThrow(
      /rev-parse --verify no-such-ref failed: fatal: Needed a single revision/,
    );
    expect(fixtureGit(work, ["show", "-s", "--format=%s", "HEAD"])).toBe("a");
  });
});
