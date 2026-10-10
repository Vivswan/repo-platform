// A stale release PR cuts a release missing commits already on the base branch: its version and changelog were computed
// before them. The merge ref GitHub checks out by default already contains the base tip, so the caller checks out the PR
// HEAD with full history. The verdict is the `behind` output, which fleet.yml reads as the literal 'true' to run
// release-please's refresh in the same run; a stale head is never a failure here. An errored look (no origin/<base>, a
// shallow checkout) throws; it is never read as either verdict.

import { appendFileSync } from "node:fs";
import {
  capture,
  error,
  failureDetail,
  requireEnv,
  succeeded,
  warning,
} from "../shared/action_runtime.ts";

const GIT_HANG_BOUND_MS = 60_000;

/** The base tip as this run's checkout fetched it; release-health.ts's after-refresh mode reads it as the main release-please saw. */
export function baseTip(base: string): string {
  const read = capture(["git", "rev-parse", "--verify", `origin/${base}^{commit}`], {
    timeoutMs: GIT_HANG_BOUND_MS,
  });
  if (!succeeded(read.exit)) {
    throw new Error(
      `origin/${base} does not resolve in this checkout (${failureDetail(read)}); the check needs a full-history checkout of the PR head`,
    );
  }
  return read.stdout.trim();
}

/** git answers yes with 0 and no with 1; any other exit is an errored look, not a no. */
function headContains(sha: string): boolean {
  const probe = capture(["git", "merge-base", "--is-ancestor", sha, "HEAD"], {
    timeoutMs: GIT_HANG_BOUND_MS,
  });
  if (probe.exit.kind === "exited" && probe.exit.code === 0) return true;
  if (probe.exit.kind === "exited" && probe.exit.code === 1) return false;
  throw new Error(`git merge-base could not answer (${failureDetail(probe)}); refusing to guess`);
}

function main(): number {
  const base = requireEnv("GITHUB_BASE_REF");
  const outputFile = requireEnv("GITHUB_OUTPUT");
  const tip = baseTip(base);
  const behind = !headContains(tip);
  appendFileSync(outputFile, `behind=${behind}\n`);
  if (!behind) {
    console.log(`release PR contains the ${base} tip (${tip})`);
    return 0;
  }
  warning(
    `Release PR is behind ${base} (tip ${tip}); its version and changelog would miss commits already on ${base}. release-please refreshes it from ${base} in this run.`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
