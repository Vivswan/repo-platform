// The steps run the SOURCE commit's own branch_tree.ts and lockfile, never this checkout's,
// so the proof compares against what that commit could have built.

import { join } from "node:path";
import { env } from "./gha.ts";
import { capture, exitCodeOf, redactCommand } from "./proc.ts";
import { stageComposedTreeArgv } from "./stage_tree.ts";

/** Read at call time so tests can shrink it. The default sits well above the measured normal (0.6-2 s warm, low minutes on a
 * cold bun cache) and inside the job's headroom, so a wedged `bun install` fails named here instead of as a runner-level kill. */
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

// Its own spawn rather than proc.ts's passthrough, which is deadline-free by contract; the other two choices mirror proc.ts:
//   env: { ...process.env }    -> a caller's GIT_* scrub reaches the child; a stray startup GIT_DIR would otherwise redirect the git steps
//   redactCommand in the error -> argv is where the sync pipeline carries its PAT-in-URL shapes, and the message can land in a public log
function step(command: string[]): void {
  const timeoutMs = stepTimeoutMs();
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

/** The hash goes through a scratch repo's index so file modes and symlinks land in the comparison too.
 * The caller owns removing srcDir (a registered worktree) and treeDir, success or not. */
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
  // rationale), or the hash skews - turning the provenance tree proof
  // into a false tamper accusation. The SOURCE worktree checkout is left as-is on
  // purpose: the repo's own .gitattributes governs it, and the scratch
  // repo is where the skew was measured.
  step(stageComposedTreeArgv(treeDir));
  return stepCapture(["git", "-C", treeDir, "write-tree"]);
}
