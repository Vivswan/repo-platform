// The row job's wall-clock budget, summed from the bounds its steps run
// under; sync-repos.yml's row timeout-minutes must cover it (the
// operator-verdict-only rule, scripts/check/ssot/sync_operator.ts, judges
// that). A row the runner kills at its timeout files no failure report in
// the target, so every bound a step can hit before deliver.ts writes the
// issue counts here.

import { NETWORK_TIMEOUT_MS } from "../fleet/discovery.ts";
import { DEFAULT_HANG_BOUND_MS } from "../shared/proc.ts";
import { DELIVERY_CALL_BOUND_MS, DELIVERY_CALLS } from "./deliver.ts";

/** The resolver's one listing of the owner's repositories (resolve_row.ts), under the fleet network bound. */
export const LISTING_BUDGET_MS = NETWORK_TIMEOUT_MS;
/** The target checkout (checkout_target.ts): the clone and the credential
 *  strip, two git calls under the hang bound. */
export const CHECKOUT_BUDGET_MS = 2 * DEFAULT_HANG_BOUND_MS;
export const DELIVERY_BUDGET_MS = DELIVERY_CALLS * DELIVERY_CALL_BOUND_MS;
/** The steps outside those bounds: this repository's checkout, bun's
 *  setup and install, and the printer, all local or the runner's own. */
export const SETUP_MINUTES = 5;

/** The writer's git calls are local to the clone, so its step's own timeout-minutes is its bound. */
export function rowBudgetMinutes(writerMinutes: number): number {
  const bounded = LISTING_BUDGET_MS + CHECKOUT_BUDGET_MS + DELIVERY_BUDGET_MS;
  return Math.ceil(bounded / 60_000) + writerMinutes + SETUP_MINUTES;
}
