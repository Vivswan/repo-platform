import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gitAnswersYes,
  gitRemoteRef,
  gitResolvedCommit,
} from "../../.github/scripts/shared/git_yes_no.ts";
import type { RunOptions } from "../../.github/scripts/shared/proc.ts";
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
  fixtureGit(cwd, ["remote", "add", "origin", cwd]);
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

  test("a remote ref reads as the sha listed, an absent ref as empty, and an errored look throws", () => {
    const options = { cwd: repo.cwd, env };
    fixtureGit(repo.cwd, ["tag", "-a", "-m", "by hand", "marked", repo.first]);
    const tagObject = fixtureGit(repo.cwd, ["rev-parse", "refs/tags/marked"]);
    expect(tagObject).not.toBe(repo.first);
    expect(gitRemoteRef("origin", "refs/heads/main", options)).toBe(repo.second);
    // The tag object itself, not the commit it names: a lease push must name what the remote lists.
    expect(gitRemoteRef("origin", "refs/tags/marked", options)).toBe(tagObject);
    expect(gitRemoteRef("origin", "refs/heads/nope", options)).toBe("");
    // Exit 128 stays an errored look beside ls-remote's no exit of 2.
    expect(() => gitRemoteRef(join(repo.cwd, "missing.git"), "HEAD", options)).toThrow(
      "git ls-remote could not answer (exit 128); refusing to guess: fatal: ",
    );
  });

  const SHA = "8096c4920f84ec4122d14c5bd884703dd0d382ba";
  const OTHER = "0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4";
  test.each([
    {
      reason: "the ref's own line decides, whatever else the listing carries",
      listing: `${OTHER}\trefs/heads/main-old\n${SHA}\trefs/heads/main\n`,
      expected: SHA,
    },
    {
      reason: "a listing without the ref's line is an errored look, never a sha",
      listing: `${OTHER}\trefs/heads/other\n`,
      expected: null,
    },
    {
      reason: "a short sha on the ref's line is an errored look, never a sha",
      listing: "deadbeef\trefs/heads/main\n",
      expected: null,
    },
  ])("$reason", ({ listing, expected }) => {
    // A git on PATH that exits 0 with a listing of the test's choosing: a line the real remote would
    // never send, read as a sha, would ride "" or "deadbeef" into a lease or a newest-wins comparison.
    const bin = temp.dir("git-yes-no-bin-");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '${listing}'\n`, { mode: 0o755 });
    const ask = () =>
      gitRemoteRef("origin", "refs/heads/main", {
        cwd: repo.cwd,
        env: { ...env, PATH: `${bin}:${process.env.PATH}` },
      });
    if (expected === null) {
      expect(ask).toThrow(`git ls-remote listed no refs/heads/main line:\n${listing}`);
    } else {
      expect(ask()).toBe(expected);
    }
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
    [
      "merge-base's no (exit 1)",
      1,
      (options: RunOptions) =>
        gitAnswersYes(["merge-base", "--is-ancestor", repo.first, repo.second], options),
      "merge-base",
    ],
    [
      "ls-remote's no (exit 2)",
      2,
      (options: RunOptions) => gitRemoteRef("origin", "refs/heads/main", options),
      "ls-remote",
    ],
  ])("a deadline expiry beside %s throws, never reads as one", (_name, exit, ask, subcommand) => {
    // A git on PATH that answers no and leaves a descendant holding the pipe: capture() returns
    // at the deadline carrying the no exit and timedOut, and the exit code alone would read as a no.
    const bin = temp.dir("git-yes-no-bin-");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 1 &\nexit ${exit}\n`, { mode: 0o755 });
    expect(() =>
      ask({
        cwd: repo.cwd,
        env: { ...env, PATH: `${bin}:${process.env.PATH}` },
        timeoutMs: 200,
      }),
    ).toThrow(`git ${subcommand} could not answer (timed out); refusing to guess: `);
  });
});
