// Copilot code review's identity, shared by ci.yml's copilot-review gate
// (copilot_review_gate.ts) and its re-armer (rerun_copilot_gate.ts) so
// the two can never drift on WHO Copilot is: the check run it creates on
// the PR head sha, and the logins it appears under (the requested
// reviewer is "Copilot", the posted review's author is the [bot] form).

export const COPILOT_CHECK_NAME = "copilot-pull-request-reviewer";

const COPILOT_LOGINS = new Set(["copilot", `${COPILOT_CHECK_NAME}[bot]`]);

export function isCopilot(login: string): boolean {
  return COPILOT_LOGINS.has(login.toLowerCase());
}
