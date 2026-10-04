// A stale release PR cuts a release missing commits already on the base branch: its version and changelog were computed
// before them. The merge ref GitHub checks out by default already contains the base tip, so the caller checks out the PR
// HEAD with full history. An errored look (no origin/<base>, a shallow checkout) throws; it is never read as "behind".

import { capture, error, failureDetail, requireEnv, succeeded } from "../shared/action_runtime.ts";

const GIT_HANG_BOUND_MS = 60_000;

function baseTip(base: string): string {
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
  const tip = baseTip(base);
  if (headContains(tip)) {
    console.log(`release PR contains the ${base} tip (${tip})`);
    return 0;
  }
  error(
    `Release PR is behind ${base} (tip ${tip}); its version and changelog would miss commits already on ${base}. Do not merge; release-please refreshes the PR after the next green run on ${base}.`,
  );
  return 1;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
