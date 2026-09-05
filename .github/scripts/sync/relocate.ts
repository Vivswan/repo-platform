// Shared mechanics for the sync's one-shot file relocations (a rendered
// path moving from the repository root under .github/): refuse a
// destination whose parent is not a real directory, probe both spellings
// without reading through symlinks, and `git mv` a legacy-path file so
// the blob rides the rename with its bytes untouched. Each
// transition script owns its own verdict policy (which locations are
// errors) and its own PR-body note; this module owns only the probe and
// the move, so the two can never disagree on what "a file at this path"
// means.

import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { identityArgs, SYNC_IDENTITY } from "../shared/git_identity.ts";
import { must } from "../shared/proc.ts";
import { walkParents } from "./checkout_path.ts";

export type Location = "in-place" | "moved" | "missing" | "both" | "not-a-file" | "unsafe-parent";

/** What sits at `path`: a regular file, nothing, or something else -
 * probed with lstat so a symlink never reads as the file it points at.
 * ENOENT is genuine absence; ENOTDIR means a parent segment is itself a
 * file (a `.github` FILE, say), which is the same broken shape as a
 * non-file entry; anything else (EACCES, EIO) throws - a permission
 * failure must never read as "absent". */
export function entryKind(path: string): "file" | "absent" | "other" {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    if (code === "ENOTDIR") return "other";
    throw err;
  }
  return stat.isFile() ? "file" : "other";
}

/** Where the target keeps the file: at `current`, at `legacy` (then moved
 * to `current` with `git mv`, bytes untouched, left STAGED for the caller
 * to commit), at neither, at both, as something other than a regular
 * file, or beneath a parent that is not a real directory (a symlinked or
 * file-shaped `.github`: probing through it would judge outside content,
 * and `git mv` into it exits 0 and writes wherever the link points, so
 * this is answered before either). A missing parent is created by the
 * move. The caller decides which of these are errors. */
export function relocateFile(targetDir: string, legacy: string, current: string): Location {
  for (const rel of [legacy, current]) {
    if (walkParents(targetDir, rel).kind === "not-a-directory") return "unsafe-parent";
  }
  const legacyKind = entryKind(join(targetDir, legacy));
  const currentKind = entryKind(join(targetDir, current));
  if (legacyKind === "other" || currentKind === "other") return "not-a-file";
  if (legacyKind === "file" && currentKind === "file") return "both";
  if (legacyKind === "absent" && currentKind === "absent") return "missing";
  if (currentKind === "file") return "in-place";
  // Every fleet repo carries .github/ (its workflows live there), but a
  // bare mkdir keeps the move total rather than order-dependent.
  mkdirSync(join(targetDir, dirname(current)), { recursive: true });
  must(["git", "-C", targetDir, "mv", legacy, current]);
  return "moved";
}

/** Commit staged relocations as the sync's own identity, pathspec-limited
 * to `paths`: ONLY the renames ride this commit, whatever else the index
 * happens to hold - anything unrelated stays behind and fails loudly at
 * copier's own dirty-tree check instead of smuggling through. */
export function commitRelocation(targetDir: string, subject: string, paths: string[]): void {
  must([
    "git",
    "-C",
    targetDir,
    ...identityArgs(SYNC_IDENTITY),
    "commit",
    "-qm",
    subject,
    "--",
    ...paths,
  ]);
}
