import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Symbolic links are neither walked nor listed: the files/ tree holds none, and a link would otherwise be read as the file it points at. */
export function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory()) visit(childRel);
      else if (stat.isFile()) found.push(childRel);
    }
  };
  visit("");
  return found.sort();
}
