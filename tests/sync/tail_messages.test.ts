// The sync's tail messages over every delivery shape: default and branch
// mode, public and hidden target, pushed or not, a PR or none.

import { describe, expect, test } from "bun:test";
import {
  conflictsMessage,
  type TailFacts,
  validationFailureMessage,
} from "../../.github/scripts/sync/tail_messages.ts";

const LOG = "the 'Validate the updated tree' step log";
const PR_BODY = "the PR body - this public log hides them (private repository)";
const PR_COMMENT = "the sync's comment on the PR - this public log hides them (private repository)";
const ISSUE =
  "hidden from this public log (private repository); delivered to the target's failure-report issue, or reproduce validation locally per docs/private-repos.md";

describe("validationFailureMessage", () => {
  test.each<{
    reason: string;
    facts: Parameters<typeof validationFailureMessage>[0];
    expected: string;
  }>([
    {
      reason: "default mode, public, PR opened",
      facts: {
        display: "o/r",
        hidden: false,
        mode: "default",
        branch: "automation/repo-platform",
        prUrl: "https://x/pull/1",
        pushed: true,
      },
      expected: `the update was pushed but validation of the resulting tree failed (details in ${LOG}). Fix the tree in https://x/pull/1 before merging.`,
    },
    {
      reason: "default mode, public, nothing to deliver: the default branch itself fails",
      facts: {
        display: "o/r",
        hidden: false,
        mode: "default",
        branch: "automation/repo-platform",
        prUrl: "",
        pushed: false,
      },
      expected: `the update produced no changes to deliver, yet validation failed, so o/r's default branch itself does not validate (details in ${LOG}). Fix the tree on its default branch, then re-run the sync.`,
    },
    {
      reason: "default mode, hidden, PR opened: the body carries the diagnostics",
      facts: {
        display: "repo #1",
        hidden: true,
        mode: "default",
        branch: "automation/repo-platform",
        prUrl: "https://x/pull/1",
        pushed: true,
      },
      expected: `the update was pushed but validation of the resulting tree failed (details in ${PR_BODY}). Fix the tree in https://x/pull/1 before merging.`,
    },
    {
      reason: "default mode, hidden, no PR: the failure-report issue carries them",
      facts: {
        display: "repo #1",
        hidden: true,
        mode: "default",
        branch: "automation/repo-platform",
        prUrl: "",
        pushed: false,
      },
      expected: `the update produced no changes to deliver, yet validation failed, so repo #1's default branch itself does not validate (details in ${ISSUE}). Fix the tree on its default branch, then re-run the sync.`,
    },
    {
      reason: "branch mode, public, pushed: fix the branch",
      facts: {
        display: "o/r",
        hidden: false,
        mode: "branch",
        branch: "chore/fuzzer",
        prUrl: "",
        pushed: true,
      },
      expected: `the render was pushed to o/r's branch 'chore/fuzzer' but validation of the resulting tree failed (details in ${LOG}). Fix the tree on that branch before merging its PR.`,
    },
    {
      reason: "branch mode, hidden, pushed with a PR comment: the branch stays unnamed",
      facts: {
        display: "repo #1",
        hidden: true,
        mode: "branch",
        branch: "chore/fuzzer",
        prUrl: "https://x/pull/9",
        pushed: true,
      },
      expected: `the render was pushed to repo #1's branch (name hidden) but validation of the resulting tree failed (details in ${PR_COMMENT}). Fix the tree on that branch before merging its PR.`,
    },
    {
      reason: "branch mode, public, nothing to deliver: the branch itself fails",
      facts: {
        display: "o/r",
        hidden: false,
        mode: "branch",
        branch: "chore/fuzzer",
        prUrl: "",
        pushed: false,
      },
      expected: `o/r's branch 'chore/fuzzer' produced no changes to deliver, yet validation failed, so the branch itself does not validate (details in ${LOG}). Fix the tree on that branch, then re-run the dispatch.`,
    },
  ])("$reason", ({ facts, expected }) => {
    expect(validationFailureMessage(facts)).toBe(expected);
  });
});

describe("conflictsMessage", () => {
  const LEAD =
    "copier hit merge conflicts in o/r; where possible they were resolved in favor of the template.";
  const facts = (over: Partial<TailFacts>): TailFacts => ({
    display: "o/r",
    hidden: false,
    mode: "default",
    branch: "",
    prUrl: "",
    pushed: true,
    ...over,
  });
  test.each<{ reason: string; facts: TailFacts; expected: string }>([
    {
      reason: "default mode, public, with the sync PR",
      facts: facts({ prUrl: "https://x/pull/1" }),
      expected: `${LEAD} The dropped local lines are listed in the PR body and in the 'Resolve copier conflicts' step log. Review https://x/pull/1, restore anything that should stay local, then merge.`,
    },
    {
      reason: "default mode, hidden: the body only",
      facts: facts({ hidden: true, prUrl: "https://x/pull/1" }),
      expected: `${LEAD} The dropped local lines are listed in the PR body ONLY (this log hides them: private repository). Review the PR, restore anything that should stay local, then merge.`,
    },
    {
      reason: "branch mode, public, with the branch's PR: the comment and the log",
      facts: facts({ mode: "branch", branch: "chore/fuzzer", prUrl: "https://x/pull/9" }),
      expected: `${LEAD} The dropped local lines are listed in the sync's comment on the PR and in the 'Resolve copier conflicts' step log. Review https://x/pull/9, restore anything that should stay local, then merge.`,
    },
    {
      reason:
        "branch mode, public, no PR on the branch: the log alone, the pushed commit is what to review",
      facts: facts({ mode: "branch", branch: "chore/fuzzer" }),
      expected: `${LEAD} The dropped local lines are listed in the 'Resolve copier conflicts' step log. Review the pushed commit, restore anything that should stay local, then merge.`,
    },
    {
      reason:
        "branch mode, hidden, no PR on the branch: nothing carries the lines, and the message says so",
      facts: facts({ mode: "branch", branch: "chore/fuzzer", hidden: true }),
      expected:
        `${LEAD} The dropped local lines are hidden from this log (private repository) and no pull ` +
        "request has the branch to carry them: diff the pushed commit against the branch's previous " +
        "head to see what the resolution dropped, then restore anything that should stay local, " +
        "then merge.",
    },
    {
      reason: "branch mode, hidden: the comment, not the body",
      facts: facts({
        mode: "branch",
        branch: "chore/fuzzer",
        hidden: true,
        prUrl: "https://x/pull/9",
      }),
      expected: `${LEAD} The dropped local lines are listed in the sync's comment on the PR ONLY (this log hides them: private repository). Review the PR, restore anything that should stay local, then merge.`,
    },
  ])("$reason", ({ facts, expected }) => {
    expect(conflictsMessage(facts)).toBe(expected);
  });
});
