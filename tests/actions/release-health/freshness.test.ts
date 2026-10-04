// git answers `merge-base --is-ancestor` with 0, 1, or an error exit, and the shell this replaces read every non-zero
// as "behind" (a missing origin/<base> failed earlier, in git's own words): the three answers and the line each one
// shows are pinned here against a hand-made history, with the script run as the action runs it.

import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/release-health/freshness.ts");
const scratch = temp.dir("release-freshness-");

// No user or system git config: a global commit.gpgsign or core.commentChar would change what the scratch repo stores.
const GIT_PINS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(repo: string, args: string[]): string {
  const result = boundedSpawnSync(["git", ...args], {
    cwd: repo,
    env: { PATH: process.env.PATH, ...GIT_PINS },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** main: root -> tip, with origin/main at the tip; `fresh` branches from the tip, `stale` from the root. */
function history(): { repo: string; tip: string } {
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "chore: root"]);
  const root = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "feat: on main"]);
  const tip = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", tip]);
  git(repo, ["checkout", "-q", "-b", "fresh"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "chore: release 1.3.0"]);
  git(repo, ["checkout", "-q", "-b", "stale", root]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "chore: release 1.2.0"]);
  return { repo, tip };
}

const { repo, tip } = history();

function check(branch: string, base: string): { exitCode: number; stdout: string; stderr: string } {
  git(repo, ["checkout", "-q", branch]);
  const result = boundedSpawnSync([process.execPath, SCRIPT], {
    cwd: repo,
    env: { PATH: process.env.PATH, ...GIT_PINS, GITHUB_BASE_REF: base },
  });
  return { exitCode: result.exitCode, stdout: result.stdout.trimEnd(), stderr: result.stderr };
}

test.each<{ reason: string; branch: string; base: string; exitCode: number; stdout: string }>([
  {
    reason: "the head contains the base tip",
    branch: "fresh",
    base: "main",
    exitCode: 0,
    stdout: `release PR contains the main tip (${tip})`,
  },
  {
    reason: "the head is behind the base tip",
    branch: "stale",
    base: "main",
    exitCode: 1,
    stdout: `::error::Release PR is behind main (tip ${tip}); its version and changelog would miss commits already on main. Do not merge; release-please refreshes the PR after the next green run on main.`,
  },
  {
    reason: "no origin/<base> in the checkout is an errored look, never a verdict",
    branch: "fresh",
    base: "develop",
    exitCode: 1,
    stdout:
      "::error::origin/develop does not resolve in this checkout (fatal: Needed a single revision); the check needs a full-history checkout of the PR head",
  },
])("$reason", ({ branch, base, exitCode, stdout }) => {
  expect(check(branch, base)).toEqual({ exitCode, stdout, stderr: "" });
});
