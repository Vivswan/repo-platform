// Copilot code review's identity, shared by ci.yml's copilot-review gate
// (copilot_review_gate.ts) and its re-armer (rerun_copilot_gate.ts) so
// the two can never drift on WHO Copilot is: the check run it creates on
// the PR head sha, and the logins it appears under (the requested
// reviewer is "Copilot", the posted review's author is the [bot] form).
// The paginated reviews read lives here for the same reason: the two
// sides must never drift on HOW the review list is fetched.

import { type ZodType, z } from "zod";
import { parseJsonWith } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";

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
