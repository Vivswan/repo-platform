// The directory segments of a target-relative path are target-controlled:
// a `.github` that is a symlink (or a file) routes any read or write
// through it outside the checkout, and `git mv` into a symlinked directory
// exits 0 and writes wherever the link points. One lstat walk answers "is
// every existing parent a real directory" for the answers-file boundary
// and the relocations alike.

import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";

export type ParentWalk =
  | { kind: "real" }
  | { kind: "missing"; segment: string }
  | { kind: "not-a-directory"; segment: string };

/** lstat each directory segment of `rel` beneath `root`, in order, stopping
 * at the first that is absent (nothing beneath it can exist; the caller
 * decides whether that is creatable) or is not a real directory (a symlink
 * or a file). Only ENOENT and ENOTDIR read as absence; any other failure to
 * look (EACCES, EIO, ELOOP) propagates. */
export function walkParents(root: string, rel: string): ParentWalk {
  const dir = dirname(rel);
  if (dir === ".") return { kind: "real" };
  let current = root;
  for (const segment of dir.split("/")) {
    current = join(current, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      return { kind: "missing", segment };
    }
    if (!stat.isDirectory()) return { kind: "not-a-directory", segment };
  }
  return { kind: "real" };
}
