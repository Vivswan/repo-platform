// git answers `merge-base --is-ancestor` with 0, 1, or an error exit, and the shell this replaces read every non-zero
// as "behind" (a missing origin/<base> failed earlier, in git's own words): the three answers are pinned here against a
// hand-made history, with the script run as the action runs it. The verdict leaves the script as the `behind` output,
// which fleet-ci.yml reads as the literal 'true' to run the refresh: a lost or misspelled output reads as "not behind"
// there, and the stale PR passes green with no refresh, so the bytes written to GITHUB_OUTPUT are pinned too.

import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

interface Check {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The bytes left in GITHUB_OUTPUT. */
  outputs: string;
}

function check(branch: string, base: string): Check {
  git(repo, ["checkout", "-q", branch]);
  const outputFile = join(scratch, `${branch}-${base}-outputs.txt`);
  writeFileSync(outputFile, "");
  const result = boundedSpawnSync([process.execPath, SCRIPT], {
    cwd: repo,
    env: { PATH: process.env.PATH, ...GIT_PINS, GITHUB_BASE_REF: base, GITHUB_OUTPUT: outputFile },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr,
    outputs: readFileSync(outputFile, "utf8"),
  };
}

test.each<{ reason: string; branch: string; base: string; expected: Check }>([
  {
    reason: "the head contains the base tip",
    branch: "fresh",
    base: "main",
    expected: {
      exitCode: 0,
      stdout: `release PR contains the main tip (${tip})`,
      stderr: "",
      outputs: "behind=false\n",
    },
  },
  {
    reason: "the head behind the base tip is a warning and behind=true, never a failure",
    branch: "stale",
    base: "main",
    expected: {
      exitCode: 0,
      stdout: `::warning::Release PR is behind main (tip ${tip}); its version and changelog would miss commits already on main. release-please refreshes it from main in this run.`,
      stderr: "",
      outputs: "behind=true\n",
    },
  },
  {
    reason:
      "no origin/<base> in the checkout is an errored look, never a verdict in either direction",
    branch: "fresh",
    base: "develop",
    expected: {
      exitCode: 1,
      stdout:
        "::error::origin/develop does not resolve in this checkout (fatal: Needed a single revision); the check needs a full-history checkout of the PR head",
      stderr: "",
      outputs: "",
    },
  },
])("$reason", ({ branch, base, expected }) => {
  expect(check(branch, base)).toEqual(expected);
});
