// Copilot code review's identity, shared by the copilot-review-gate action
// (gate.ts) and the copilot-rearm action that re-arms it (rerun.ts) so the
// two can never drift on WHO Copilot is: the check run it creates on the PR
// head sha, and the logins it appears under (the requested reviewer is
// "Copilot", the posted review's author is the [bot] form). The paginated
// reviews read lives here for the same reason: the two sides must never
// drift on HOW the review list is fetched.
//
// A published action cannot import out of its own directory, so "shared"
// here means BYTE-IDENTICAL copies in the two action directories rather
// than one import. copilot_shared_files.test.ts fails the moment they
// differ, which is what keeps a login rename a one-edit change that CI
// polices. Edit one, copy it to the other.

import { type ZodType, z } from "zod";
import { capture, parseJsonWith } from "./runtime.ts";

export const COPILOT_CHECK_NAME = "copilot-pull-request-reviewer";

const COPILOT_LOGINS = new Set(["copilot", `${COPILOT_CHECK_NAME}[bot]`]);

export function isCopilot(login: string): boolean {
  return COPILOT_LOGINS.has(login.toLowerCase());
}

/** One review of a PR's review list, as both gate sides read it. */
export const reviewSchema = z.object({
  commit_id: z.string(),
  user: z.object({ login: z.string() }).nullable(),
});

/** A commit's Copilot check runs, as both gate sides read them: the
 * pull_requests associations are what scopes acceptance to ONE PR. */
export const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      status: z.string(),
      pull_requests: z.array(z.object({ number: z.number() })).optional(),
    }),
  ),
});

/** Whether a completed Copilot check run vouches for THIS PR. Check runs
 * are COMMIT-scoped: the same head sha on a sibling PR (stacked PRs do
 * this constantly) carries the OTHER PR's check run, so a bare
 * completed-at-this-sha acceptance satisfies the wrong PR's gate -
 * acceptance requires the run's PR associations to name this PR. One
 * predicate for the gate and its re-armer, so the two can never drift. */
export function checkRunArrivedForPr(
  checkRuns: z.infer<typeof checkRunsSchema>["check_runs"],
  prNumber: number,
): boolean {
  return checkRuns.some(
    (run) =>
      run.status === "completed" &&
      (run.pull_requests ?? []).some((pull) => pull.number === prNumber),
  );
}

/** Every review of a PR, ALL pages: GET reviews is OLDEST-first, so a
 * single page of a >100-review PR shows only stale reviews - the gate
 * would fail red forever and the re-armer would strand it (the fresh
 * head's review never becomes visible). gh api --paginate --slurp emits
 * one JSON array of per-page arrays; the schema mirrors that and the
 * result flattens. Null on a FAILED call (each caller decides: the gate
 * fails closed, the re-armer exits loudly); a schema-rejecting response
 * exits the process like every other read. `timeoutMs` covers N
 * sequential page fetches under ONE deadline, so callers pass a budget
 * several times their single-call probe deadline. */
export function fetchAllReviews(
  repository: string,
  prNumber: string | number,
  label: string,
  timeoutMs: number,
): z.infer<typeof reviewSchema>[] | null {
  const probe = capture(
    [
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/pulls/${prNumber}/reviews?per_page=100`,
    ],
    { timeoutMs },
  );
  if (probe.exitCode !== 0) return null;
  return parseJsonWith(
    z.array(z.array(reviewSchema)) as ZodType<z.infer<typeof reviewSchema>[][]>,
    probe.stdout,
    label,
  ).flat();
}
