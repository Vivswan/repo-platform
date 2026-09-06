// Per-run scratch roots for the build-branch producers, minted fresh under
// RUNNER_TEMP (or os.tmpdir()) so concurrent producers never share a worktree,
// and removed at process exit; a signal kill leaves the root to its owner.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, warning } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";

export interface ScratchWorktrees {
  /** The source commit's own checkout: its script and lockfile compose the tree. */
  src: string;
  /** The composed tree. */
  tree: string;
  /** The worktree the commit is built in and pushed from. */
  out: string;
}

/** Mints this run's scratch worktree paths and arms their removal at process
 * exit, followed by a prune of the calling checkout's worktree list: a
 * registered-but-missing entry would block the path from being added again. */
export function scratchWorktrees(): ScratchWorktrees {
  const checkout = process.cwd();
  const root = mkdtempSync(join(env("RUNNER_TEMP") || tmpdir(), "build-branches-"));
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } finally {
      const pruned = capture(["git", "worktree", "prune"], { cwd: checkout });
      if (pruned.exitCode !== 0) {
        warning(
          `git worktree prune in ${checkout} failed after removing ${root} (exit ${pruned.exitCode}): ${pruned.stderr.trim()}`,
        );
      }
    }
  });
  return { src: join(root, "src"), tree: join(root, "tree"), out: join(root, "out") };
}
