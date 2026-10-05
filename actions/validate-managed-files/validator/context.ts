import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_CHECKOUT_DIR } from "../../shared/platform.ts";

export interface Context {
  root: string;
  /** Every regular file below root, sorted, relative paths. */
  files: readonly string[];
}

/** One walk feeds every check: everything but `.git` (at any depth: a nested checkout's is working state, never
 *  content) and the platform checkout fleet-ci.yml makes at the root. */
export function loadContext(root: string): Context {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      if (name === ".git") continue;
      if (rel === "" && name === PLATFORM_CHECKOUT_DIR) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else if (stat.isFile() && !stat.isSymbolicLink()) found.push(childRel);
    }
  };
  visit("");
  return { root, files: found.sort() };
}
