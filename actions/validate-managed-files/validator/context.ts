import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { yamllintIgnore } from "./yamllint_ignore.ts";

export interface Context {
  root: string;
  /** Every regular file below root, sorted, relative paths. */
  files: readonly string[];
}

/** One walk feeds every check, and it reads the tree yamllint reads: everything but `.git` (at any depth: a nested
 *  checkout's is working state, never content) and what the repository's own .yamllint ignores. */
export function loadContext(root: string): Context {
  const skips = yamllintIgnore(root);
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      if (name === ".git") continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!skips(childRel, true)) visit(childRel);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        if (!skips(childRel, false)) found.push(childRel);
      }
    }
  };
  visit("");
  return { root, files: found.sort() };
}
