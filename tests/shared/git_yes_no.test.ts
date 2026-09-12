import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitAnswersYes, gitResolvedCommit } from "../../.github/scripts/shared/git_yes_no.ts";
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

describe("git yes/no helpers", () => {
  const repo = fixtureRepo();
  const env = fixtureGitEnv();

  // The test process's own cwd is another repository, so a cwd option the helper ignored would
  // fail every row that names a fixture commit.
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

  test("a question with its own no exit (ls-remote --exit-code) reads 2 as the no", () => {
    const options = { cwd: repo.cwd, env, noExit: 2 };
    fixtureGit(repo.cwd, ["remote", "add", "origin", repo.cwd]);
    expect(gitAnswersYes(["ls-remote", "--exit-code", "origin", "refs/heads/main"], options)).toBe(
      true,
    );
    expect(gitAnswersYes(["ls-remote", "--exit-code", "origin", "refs/heads/nope"], options)).toBe(
      false,
    );
    // Exit 128 stays an errored look under the other no exit as well.
    expect(() =>
      gitAnswersYes(["ls-remote", "--exit-code", join(repo.cwd, "missing.git"), "HEAD"], options),
    ).toThrow("git ls-remote could not answer (exit 128); refusing to guess: fatal: ");
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

  test("a resolved commit is its sha, anything else is empty, and an errored look throws", () => {
    const options = { cwd: repo.cwd, env };
    expect(gitResolvedCommit(repo.first, options)).toBe(repo.first);
    expect(gitResolvedCommit("refs/heads/nope", options)).toBe("");
    // A tree resolves but is no commit: the helper peels, so a blob or tree sha never passes for one.
    expect(gitResolvedCommit(`${repo.first}^{tree}`, options)).toBe("");
    // Outside any repository rev-parse exits 128, which read as "" would pass for an absent commit.
    expect(() => gitResolvedCommit(repo.first, { cwd: temp.dir("no-repo-"), env })).toThrow(
      "git rev-parse could not answer (exit 128); refusing to guess: fatal: not a git repository",
    );
  });

  test.each([
    ["the default no", 1, {}],
    ["ls-remote's no", 2, { noExit: 2 }],
  ])("a deadline expiry beside %s (exit %d) throws, never reads as one", (_name, exit, noExit) => {
    // A git on PATH that answers no and leaves a descendant holding the pipe: capture() returns
    // at the deadline carrying the no exit and timedOut, and the exit code alone would read as a no.
    const bin = temp.dir("git-yes-no-bin-");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 1 &\nexit ${exit}\n`, { mode: 0o755 });
    const args = ["merge-base", "--is-ancestor", repo.first, repo.second];
    expect(() =>
      gitAnswersYes(args, {
        cwd: repo.cwd,
        env: { ...env, PATH: `${bin}:${process.env.PATH}` },
        timeoutMs: 200,
        ...noExit,
      }),
    ).toThrow("git merge-base could not answer (timed out); refusing to guess: ");
  });
});
