import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The checkout a validator reads; `files` is every regular file below `root`, sorted, as relative paths. */
export interface Context {
  root: string;
  files: readonly string[];
}

/** One walk feeds every check: everything but `.git`, at any depth (a nested checkout's is working state, never
 *  content). A symbolic link is neither file nor directory to lstat, so it is skipped. */
export function loadContext(root: string): Context {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      if (name === ".git") {
        continue;
      }

      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory()) {
        visit(childRel);
        continue;
      }

      if (stat.isFile()) {
        found.push(childRel);
      }
    }
  };
  visit("");
  return { root, files: found.sort() };
}
