// Target-tree file walk shared by the sync's two conflict-recovery passes
// (resolve_copier_conflicts.ts and preserve_local_content.ts). One owner on
// purpose: the passes run back to back over the same rendered tree, and a
// skip-list that drifted between them would let one pass rewrite files the
// other never saw.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".repo-platform-src",
  "node_modules",
  ".venv",
  "__pycache__",
]);

/** All regular (non-symlink) files below root, sorted, skipping SKIP_DIRS. */
export function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (SKIP_DIRS.has(name)) continue;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else if (stat.isFile() && !stat.isSymbolicLink()) found.push(childRel);
    }
  };
  visit("");
  return found.sort();
}
