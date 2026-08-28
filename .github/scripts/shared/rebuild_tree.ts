// Rebuild the build-branch tree from a source commit exactly as the builder
// does: the SOURCE commit's own script and dependencies, so the rebuild
// reproduces that commit's composition. Shared by publish.ts (re-stamp
// proof) and sync/verify_build_provenance.ts (tree proof); what each does
// with the hash - and how it cleans up - stays its own policy.

import { join } from "node:path";
import { capture, passthrough, redactCommand } from "./proc.ts";

// redactCommand in the error text: the message can end up in a public
// log, and argv is exactly where the sync pipeline carries its
// PAT-in-URL shapes.
function step(command: string[]): void {
  if (passthrough(command) !== 0) throw new Error(`command failed: ${redactCommand(command)}`);
}

function stepCapture(command: string[]): string {
  const result = capture(command);
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
  step(["git", "-C", treeDir, "add", "-A"]);
  return stepCapture(["git", "-C", treeDir, "write-tree"]);
}
