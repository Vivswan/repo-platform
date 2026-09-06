// Per-run scratch space for the build-branch producers (publish.ts,
// build_pending.ts): the worktrees they compose in, stage in, and push
// from. Each call mints a fresh root under RUNNER_TEMP on the runner
// (per-job, runner-owned) or os.tmpdir() elsewhere, removed when the
// process exits through process.exit (the `must`/`fail` route), an
// uncaught throw, or the end of the script - bun runs "exit" listeners
// on all three. A signal kill runs no listener, and a handler could not
// help: the producers are fully synchronous, so it would fire only after
// the whole publish (push included) and turn a completed run into a
// signal exit. That residue belongs to the root's owner - the runner
// discards RUNNER_TEMP with the job, the test launcher its per-run
// TMPDIR. Fixed paths under the system temp dir let two concurrent
// producers (sibling `bun run check`s, a rerun racing a stuck step) share
// one worktree and trample each other's commits.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, warning } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";

export interface ScratchWorktrees {
  /** The source commit's own checkout: its script and lockfile compose the tree. */
  src: string;
  /** The composed (or pre-built) tree. */
  tree: string;
  /** The worktree the commit is built in and pushed from. */
  out: string;
}

/** Mints this run's scratch worktree paths and arms their removal at
 * process exit. The worktrees register in the calling checkout's admin
 * area (`git worktree add` runs in the cwd at mint time), so the exit
 * hook prunes that checkout's list after deleting the root: a
 * registered-but-missing entry would block the path from being added
 * again. Prune drops only registrations whose directories are gone and
 * skips locked ones, so nothing live is touched. */
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
