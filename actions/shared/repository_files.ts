// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

/** Node's default is 1 MiB, a few thousand paths; a large checkout lists more. */
const LIST_BUFFER_BYTES = 64 * 1024 * 1024;

/** The files a check over "the repository" judges: what git tracks and, with `untracked`, what it would track.
 *  An ignored untracked path never appears (a gitignored `.skills/` checkout once failed the typography check).
 *  A listed path may be gone from disk, or be a symlink (CLAUDE.md -> AGENTS.md is judged through its target),
 *  so only the regular files that exist are returned. */
export function repositoryFiles(root: string, options: { untracked: boolean }): string[] {
  // --deduplicate: an unresolved merge lists one path per stage.
  const args = ["-C", root, "ls-files", "-z", "--deduplicate", "--cached"];
  if (options.untracked) args.push("--others", "--exclude-standard");
  const proc = spawnSync("git", args, { encoding: "utf-8", maxBuffer: LIST_BUFFER_BYTES });
  if (proc.status !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${(proc.stderr ?? "").trim()}`);
  }
  return proc.stdout.split("\0").filter((relPath) => {
    if (relPath === "") return false;
    const path = join(root, relPath);
    return existsSync(path) && lstatSync(path).isFile();
  });
}
