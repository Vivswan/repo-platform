// One oracle for "did the tree change": every path under root but .git, a regular file by the sha256 of its bytes
// (latin1, so an invalid sequence is its own byte), a symbolic link by its target.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../actions/shared/values.ts";

export function snapshotTree(root: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (rel === ".git") continue;
    if (entry.isDirectory()) {
      for (const [path, hash] of snapshotTree(root, rel)) out.set(path, hash);
    } else if (entry.isSymbolicLink()) {
      out.set(rel, `-> ${readlinkSync(join(root, rel))}`);
    } else {
      out.set(rel, sha256(readFileSync(join(root, rel), "latin1")));
    }
  }
  return out;
}
