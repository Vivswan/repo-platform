import { describe, expect, test } from "bun:test";
import {
  MAIN_REF,
  supersededBy,
  supersededNotice,
} from "../../.github/scripts/fleet/newest_main.ts";
import type { RunResult } from "../../.github/scripts/shared/proc.ts";

const SHA = "8096c4920f84ec4122d14c5bd884703dd0d382ba";
const NEWER = "0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4";
const LS_REMOTE = ["git", "ls-remote", "--exit-code", "origin", MAIN_REF];

/** A stubbed git: one answer, and the argv it was asked. */
function gitAnswering(answer: Partial<RunResult>) {
  const asked: string[][] = [];
  const run = (command: string[]): RunResult => {
    asked.push(command);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, pid: 0, ...answer };
  };
  return { run, asked };
}

describe("supersededBy", () => {
  test.each([
    {
      reason: "the run's commit is main's tip: newest, nothing supersedes it",
      stdout: `${SHA}\t${MAIN_REF}\n`,
      expected: null,
    },
    {
      reason: "main moved on: the tip supersedes the run's commit",
      stdout: `${NEWER}\t${MAIN_REF}\n`,
      expected: NEWER,
    },
    {
      reason: "a tag or peeled line beside main is ignored; the main line decides",
      stdout: `${NEWER}\trefs/heads/main-old\n${SHA}\t${MAIN_REF}\n`,
      expected: null,
    },
  ])("$reason", ({ stdout, expected }) => {
    const git = gitAnswering({ stdout });
    expect(supersededBy(SHA, git.run)).toBe(expected);
    expect(git.asked).toEqual([LS_REMOTE]);
  });

  test.each([
    {
      reason: "a failed ls-remote (no network) throws, quoting git",
      answer: {
        exitCode: 128,
        stderr: "fatal: unable to access 'origin': Could not resolve host\n",
      },
      message: `git ls-remote for ${MAIN_REF} could not answer (exit 128); refusing to guess: fatal: unable to access 'origin': Could not resolve host`,
    },
    {
      reason: "an absent main (--exit-code's 2) is an error, never 'newest'",
      answer: { exitCode: 2 },
      message: `git ls-remote for ${MAIN_REF} could not answer (exit 2); refusing to guess: `,
    },
    {
      reason: "a stalled ls-remote throws even beside an exit code",
      answer: { exitCode: 0, timedOut: true, stdout: `${SHA}\t${MAIN_REF}\n`, stderr: "" },
      message: `git ls-remote for ${MAIN_REF} could not answer (timed out); refusing to guess: `,
    },
    {
      reason: "a listing without a main line throws, showing the listing",
      answer: { stdout: `${SHA}\trefs/heads/other\n` },
      message: `git ls-remote listed no ${MAIN_REF} line:\n${SHA}\trefs/heads/other\n`,
    },
    {
      reason: "a main line that is not a full sha throws",
      answer: { stdout: `deadbeef\t${MAIN_REF}\n` },
      message: `git ls-remote listed no ${MAIN_REF} line:\ndeadbeef\t${MAIN_REF}\n`,
    },
  ])("$reason", ({ answer, message }) => {
    const git = gitAnswering(answer);
    expect(() => supersededBy(SHA, git.run)).toThrow(message);
    expect(git.asked).toEqual([LS_REMOTE]);
  });
});

test("the stand-down notice names both commits short and says who owns the apply", () => {
  expect(supersededNotice(SHA, NEWER)).toBe(
    "superseded by 0f1e2d3c4b5a: main moved past this run's 8096c4920f84, and that commit's own run owns the settings apply - nothing to apply here",
  );
});
