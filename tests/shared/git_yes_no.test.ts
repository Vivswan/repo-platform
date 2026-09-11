// gitAnswersYes against a real repository: exit 0 is yes, exit 1 is no, and any other exit
// (git's 128 for an unknown revision) or a deadline expiry throws the whole message instead of
// reading as a no.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitAnswersYes } from "../../.github/scripts/shared/git_yes_no.ts";
import { fixtureGit, fixtureGitEnv } from "./fixture_git";
import { tempDirs } from "./temp_dir";

const temp = tempDirs();

function fixtureRepo(): { cwd: string; first: string; second: string } {
  const cwd = temp.dir("git-yes-no-");
  fixtureGit(cwd, ["init", "--quiet", "-b", "main"]);
  fixtureGit(cwd, ["config", "user.name", "t"]);
  fixtureGit(cwd, ["config", "user.email", "t@t.test"]);
  fixtureGit(cwd, ["commit", "--quiet", "--allow-empty", "-m", "first"]);
  const first = fixtureGit(cwd, ["rev-parse", "HEAD"]);
  fixtureGit(cwd, ["commit", "--quiet", "--allow-empty", "-m", "second"]);
  const second = fixtureGit(cwd, ["rev-parse", "HEAD"]);
  return { cwd, first, second };
}

describe("gitAnswersYes", () => {
  const repo = fixtureRepo();
  const env = fixtureGitEnv();

  // Rows are [question, the args, the answer]; every question runs in the fixture through the
  // cwd option, from a process whose own cwd is another repository.
  test.each([
    ["an ancestor is a yes", ["merge-base", "--is-ancestor", repo.first, repo.second], true],
    ["a descendant is a no", ["merge-base", "--is-ancestor", repo.second, repo.first], false],
    [
      "a present commit verifies",
      ["rev-parse", "--verify", "--quiet", `${repo.first}^{commit}`],
      true,
    ],
    [
      "an absent ref is a no",
      ["rev-parse", "--verify", "--quiet", "refs/heads/nope^{commit}"],
      false,
    ],
  ])("%s", (_question, args, answer) => {
    expect(gitAnswersYes(args, { cwd: repo.cwd, env })).toBe(answer);
  });

  test("an errored look throws the whole message, never a no", () => {
    // An unknown revision makes merge-base exit 128 (not 1): read as a no, a caller deciding
    // "not an ancestor" would act on an answer git never gave.
    const args = [
      "merge-base",
      "--is-ancestor",
      "0000000000000000000000000000000000000000",
      repo.first,
    ];
    expect(() => gitAnswersYes(args, { cwd: repo.cwd, env })).toThrow(
      `git merge-base could not answer (exit 128); refusing to guess: fatal: Not a valid commit name 0000000000000000000000000000000000000000`,
    );
  });

  test("a deadline expiry throws even beside a no, never reads as one", () => {
    // A git on PATH that answers no and leaves a descendant holding the pipe: capture() returns
    // at the deadline carrying exit 1 and timedOut, and the exit code alone would read as a no.
    const bin = temp.dir("git-yes-no-bin-");
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 1 &\nexit 1\n", { mode: 0o755 });
    const args = ["merge-base", "--is-ancestor", repo.first, repo.second];
    expect(() =>
      gitAnswersYes(args, {
        cwd: repo.cwd,
        env: { ...env, PATH: `${bin}:${process.env.PATH}` },
        timeoutMs: 200,
      }),
    ).toThrow("git merge-base could not answer (timed out); refusing to guess: ");
  });
});
