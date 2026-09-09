#!/usr/bin/env bun
// The sync's two tail-step messages, worded per delivery mode: where the
// diagnostics are (the log, the sync PR's body, the branch PR's comment, or
// the failure-report issue) and what to fix. `validation-failure` is the red
// step after a tree failed validation (exit 1); `conflicts` is the warning
// after copier conflicts were resolved toward the template (exit 0).
//
// Usage: tail_messages.ts validation-failure|conflicts
// Env: TARGET_DISPLAY, HIDE_DETAILS, MODE (default|branch), BRANCH (branch
// mode: the branch the render was pushed to), PR_URL (the sync PR or the
// branch's PR, may be empty), PUSHED (true when a commit was pushed).

import { env, error, hideDetails, warning } from "../shared/gha.ts";

export interface TailFacts {
  display: string;
  hidden: boolean;
  mode: string;
  branch: string;
  prUrl: string;
  pushed: boolean;
}

/** Where a hidden target's detail landed: the sync PR's body, or in branch
 *  mode the sync's comment on the branch's PR. */
function hiddenHome(mode: string): string {
  return mode === "branch" ? "the sync's comment on the PR" : "the PR body";
}

/** The red validation-failure message for one outcome. */
export function validationFailureMessage(facts: TailFacts): string {
  const { display, hidden, mode, branch, prUrl, pushed } = facts;
  let where: string;
  if (hidden && prUrl !== "") {
    // run_hidden.ts hid the diagnostics from this log; open_pr.ts routed
    // them into the sync PR's body, or the branch's PR comment.
    where = `${hiddenHome(mode)} - this public log hides them (private repository)`;
  } else if (hidden) {
    // No PR to carry them; the deliver step routes the capture to the
    // target's failure-report issue.
    where =
      "hidden from this public log (private repository); delivered to the target's failure-report issue, or reproduce validation locally per docs/private-repos.md";
  } else {
    where = "the 'Validate the updated tree' step log";
  }
  if (mode === "branch") {
    const shown = hidden ? "branch (name hidden)" : `branch '${branch}'`;
    return pushed
      ? `the render was pushed to ${display}'s ${shown} but validation of the resulting tree failed ` +
          `(details in ${where}). Fix the tree on that branch before merging its PR.`
      : `${display}'s ${shown} produced no changes to deliver, yet validation failed, so the branch ` +
          `itself does not validate (details in ${where}). Fix the tree on that branch, then re-run the dispatch.`;
  }
  return prUrl !== ""
    ? `the update was pushed but validation of the resulting tree failed (details in ${where}). ` +
        `Fix the tree in ${prUrl} before merging.`
    : `the update produced no changes to deliver, yet validation failed, so ${display}'s default branch ` +
        `itself does not validate (details in ${where}). Fix the tree on its default branch, then re-run the sync.`;
}

/** The warning after conflicts were resolved toward the template: where the
 *  dropped local lines are listed and what to review. A branch with no PR
 *  has no comment to carry them: the log has them for a public target; a
 *  hidden target's went unrecorded, and a re-run cannot reproduce them (it
 *  starts from the resolved tree), so the pushed commit's diff is the record. */
export function conflictsMessage(facts: TailFacts): string {
  const { display, hidden, mode, prUrl } = facts;
  const lead = `copier hit merge conflicts in ${display}; where possible they were resolved in favor of the template.`;
  const review = "restore anything that should stay local, then merge.";
  if (mode === "branch" && prUrl === "") {
    return hidden
      ? `${lead} The dropped local lines are hidden from this log (private repository) and no pull ` +
          "request has the branch to carry them: diff the pushed commit against the branch's previous " +
          `head to see what the resolution dropped, then ${review}`
      : `${lead} The dropped local lines are listed in the 'Resolve copier conflicts' step log. ` +
          `Review the pushed commit, ${review}`;
  }
  const home = hiddenHome(mode);
  if (hidden) {
    return `${lead} The dropped local lines are listed in ${home} ONLY (this log hides them: private repository). Review the PR, ${review}`;
  }
  return `${lead} The dropped local lines are listed in ${home} and in the 'Resolve copier conflicts' step log. Review ${prUrl}, ${review}`;
}

if (import.meta.main) {
  const facts: TailFacts = {
    display: env("TARGET_DISPLAY") || env("TARGET"),
    hidden: hideDetails(),
    mode: env("MODE"),
    branch: env("BRANCH"),
    prUrl: env("PR_URL"),
    pushed: env("PUSHED") === "true",
  };
  const step = process.argv[2];
  if (step === "validation-failure") {
    error(validationFailureMessage(facts));
    process.exit(1);
  }
  if (step === "conflicts") {
    warning(conflictsMessage(facts));
    process.exit(0);
  }
  error("tail_messages.ts: expected 'validation-failure' or 'conflicts'");
  process.exit(2);
}
