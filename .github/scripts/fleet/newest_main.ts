// The settings lane orders its runs by ARRIVAL, and CI durations vary, so an older main commit's run can take its turn after
// a newer one's (docs/settings.md, "Newest wins"). The selector asks this first: main's tip, read live with one ls-remote and no
// history, since the plan job's checkout is one commit deep.

import { capture, type RunResult } from "../shared/proc.ts";

export const MAIN_REF = "refs/heads/main";

export type Capture = (command: string[]) => RunResult;

/** Any failed look throws: read as "newest" it would let a superseded run write, read as "superseded" it would stand the
 *  newest run down. --exit-code makes an absent main exit 2, an error like any other here. */
export function remoteMainTip(run: Capture = capture): string {
  const probe = run(["git", "ls-remote", "--exit-code", "origin", MAIN_REF]);
  if (probe.timedOut || probe.exitCode !== 0) {
    const how = probe.timedOut ? "timed out" : `exit ${probe.exitCode}`;
    throw new Error(
      `git ls-remote for ${MAIN_REF} could not answer (${how}); refusing to guess: ${probe.stderr.trim()}`,
    );
  }
  const line = probe.stdout.split("\n").find((entry) => entry.endsWith(`\t${MAIN_REF}`));
  const tip = line === undefined ? "" : line.slice(0, line.indexOf("\t"));
  if (!/^[0-9a-f]{40}$/.test(tip)) {
    throw new Error(`git ls-remote listed no ${MAIN_REF} line:\n${probe.stdout}`);
  }
  return tip;
}

export function supersededBy(sha: string, run?: Capture): string | null {
  const tip = remoteMainTip(run);
  return tip === sha ? null : tip;
}

export function supersededNotice(sha: string, tip: string): string {
  return `superseded by ${tip.slice(0, 12)}: main moved past this run's ${sha.slice(0, 12)}; the tip's own run or the nightly applies - nothing to apply here`;
}
