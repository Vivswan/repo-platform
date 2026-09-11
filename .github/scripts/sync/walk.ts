// File walk shared by the sync's conflict recovery and the writer's files/
// tree check, so the two never disagree on what a tree-relative regular
// file is. SKIP_DIRS is the conflict pass's default: the generated and
// vendored directories a rendered tree carries that recovery may not touch.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".repo-platform-src",
  "node_modules",
  ".venv",
  "__pycache__",
]);

/** All regular (non-symlink) files below root, sorted, skipping every
 *  entry named in `skip` (a file under such a name included). */
export function walkFiles(root: string, skip: ReadonlySet<string> = SKIP_DIRS): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (skip.has(name)) continue;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else if (stat.isFile() && !stat.isSymbolicLink()) found.push(childRel);
    }
  };
  visit("");
  return found.sort();
}
