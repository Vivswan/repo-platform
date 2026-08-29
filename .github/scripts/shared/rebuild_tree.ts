// Rebuild the build-branch tree from a source commit exactly as the builder
// does: the SOURCE commit's own script and dependencies, so the rebuild
// reproduces that commit's composition. Two consumers:
// sync/verify_build_provenance.ts (the tree proof) and
// sync/wait_for_build.ts (the freshness slow path); what each does with
// the hash - and how it cleans up - stays its own policy.

import { join } from "node:path";
import { env } from "./gha.ts";
import { capture, exitCodeOf, redactCommand } from "./proc.ts";
import { stageComposedTreeArgv } from "./stage_tree.ts";

/** Per-step operational deadline, read at call time so tests can shrink
 * it: generous next to the measured normal (install + compose run
 * ~0.6-2 s warm, low minutes on a cold bun cache), small enough that a
 * wedged `bun install` throws here - into wait_for_build's
 * degrade-to-warn catch, or the provenance verifier's loud failure -
 * instead of eating the job's headroom toward an unnamed runner-level
 * kill. Local on purpose: proc.ts's passthrough is deadline-free by
 * contract, and this is its only inherited-stdio caller with a real
 * deadline. */
function stepTimeoutMs(): number {
  const raw = env("REBUILD_STEP_TIMEOUT_MS", "300000");
  const timeoutMs = Number(raw);
  // A malformed value must fail loud, never disable the bound: Number("")
  // is 0, and a spawnSync timeout of 0 means unbounded.
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `REBUILD_STEP_TIMEOUT_MS must be a positive integer of milliseconds, not "${raw}"`,
    );
  }
  return timeoutMs;
}

// redactCommand in the error text: the message can end up in a public
// log, and argv is exactly where the sync pipeline carries its
// PAT-in-URL shapes.
function step(command: string[]): void {
  const timeoutMs = stepTimeoutMs();
  // Live process.env handed DELIBERATELY, matching proc.ts's env
  // contract: bun's default is a process-start snapshot, so a caller's
  // GIT_* scrub would otherwise never reach these children and a stray
  // startup GIT_DIR would redirect the git steps at another repository.
  const proc = Bun.spawnSync(command, {
    env: { ...process.env },
    stdio: ["inherit", "inherit", "inherit"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout === true) {
    throw new Error(`command timed out after ${timeoutMs}ms: ${redactCommand(command)}`);
  }
  if (exitCodeOf(proc) !== 0) throw new Error(`command failed: ${redactCommand(command)}`);
}

function stepCapture(command: string[]): string {
  const timeoutMs = stepTimeoutMs();
  const result = capture(command, { timeoutMs });
  if (result.timedOut) {
    throw new Error(`command timed out after ${timeoutMs}ms: ${redactCommand(command)}`);
  }
  if (result.exitCode !== 0) throw new Error(`command failed: ${redactCommand(command)}`);
  return result.stdout.trimEnd();
}

/** Build the branch tree from `sourceSha` into `treeDir` (via a detached
 * git worktree at `srcDir`) and return its git tree hash, computed through
 * a scratch repo's index so file modes and symlinks land in the comparison
 * too. Throws on any command failure; the CALLER owns removing srcDir (a
 * registered worktree) and treeDir, success or not. */
export function rebuildBranchTree(options: {
  sourceSha: string;
  srcDir: string;
  treeDir: string;
}): string {
  const { sourceSha, srcDir, treeDir } = options;
  // Pin the one caller-controlled value to a shape that cannot carry a
  // credential or a private name: the steps run with inherited stdio, so
  // git's own errors would echo a smuggled argv value into the log raw.
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("rebuildBranchTree: sourceSha must be a full 40-hex commit sha");
  }
  step(["git", "worktree", "add", "--detach", "--quiet", srcDir, sourceSha]);
  step(["bun", "install", "--frozen-lockfile", "--cwd", srcDir, "--silent"]);
  step(["bun", join(srcDir, ".github/scripts/build-branches/branch_tree.ts"), "--dest", treeDir]);
  step(["git", "-C", treeDir, "init", "--quiet"]);
  // The staging must be the SAME function of the composed tree the
  // producers used (stage_tree.ts owns the shared argv and the hermetic
  // rationale), or the hash skews - turning wait_for_build's slow path
  // into a false "not fresh" and the provenance tree proof into a false
  // tamper accusation. The SOURCE worktree checkout is left as-is on
  // purpose: the repo's own .gitattributes governs it, and the scratch
  // repo is where the skew was measured.
  step(stageComposedTreeArgv(treeDir));
  return stepCapture(["git", "-C", treeDir, "write-tree"]);
}
