// Rebuild the build-branch tree from a source commit exactly as the builder
// does: the SOURCE commit's own script and dependencies, so the rebuild
// reproduces that commit's composition. Shared by publish.ts (re-stamp
// proof) and sync/verify_build_provenance.ts (tree proof); what each does
// with the hash - and how it cleans up - stays its own policy.

import { join } from "node:path";
import { capture, passthrough } from "./proc.ts";

function step(command: string[]): void {
  if (passthrough(command) !== 0) throw new Error(`command failed: ${command.join(" ")}`);
}

function stepCapture(command: string[]): string {
  const result = capture(command);
  if (result.exitCode !== 0) throw new Error(`command failed: ${command.join(" ")}`);
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
  step(["git", "worktree", "add", "--detach", "--quiet", srcDir, sourceSha]);
  step(["bun", "install", "--frozen-lockfile", "--cwd", srcDir, "--silent"]);
  step(["bun", join(srcDir, ".github/scripts/build-branches/branch_tree.ts"), "--dest", treeDir]);
  step(["git", "-C", treeDir, "init", "--quiet"]);
  step(["git", "-C", treeDir, "add", "-A"]);
  return stepCapture(["git", "-C", treeDir, "write-tree"]);
}
