// The settings lane orders its runs by ARRIVAL, and CI durations vary, so an older main commit's run can take its turn after
// a newer one's (docs/settings.md, "Newest wins"). The selector asks this first: main's tip, read live with one ls-remote and no
// history, since the plan job's checkout is one commit deep.

import { gitRemoteRef } from "../shared/git_yes_no.ts";
import type { RunOptions } from "../shared/proc.ts";

export const MAIN_REF = "refs/heads/main";

/** Any failed look throws, an absent main included: read as "newest" it would let a superseded run write, read as
 *  "superseded" it would stand the newest run down. */
export function remoteMainTip(options: RunOptions = {}): string {
  const tip = gitRemoteRef("origin", MAIN_REF, options);
  if (tip === "")
    throw new Error(`origin holds no ${MAIN_REF}; refusing to guess which run is newest`);
  return tip;
}

export function supersededBy(sha: string, options: RunOptions = {}): string | null {
  const tip = remoteMainTip(options);
  return tip === sha ? null : tip;
}

export function supersededNotice(sha: string, tip: string): string {
  return `superseded by ${tip.slice(0, 12)}: main moved past this run's ${sha.slice(0, 12)}; the tip's own run or the nightly applies - nothing to apply here`;
}
