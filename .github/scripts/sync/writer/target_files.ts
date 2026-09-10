// Every read, write, and unlink the writer performs inside the target
// checkout goes through here. File APIs follow symbolic links, so a linked
// ancestor directory (docs -> ../shared) would carry a write or an unlink
// outside the checkout with the final path component looking clean; the
// final component itself must be a regular file or absent.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lstatOrNull } from "../../shared/fs_probe.ts";

/** The absolute location of `path` under `target`, once no ancestor
 *  directory between them is a symbolic link. */
export function insideTarget(target: string, path: string): string {
  for (let dir = dirname(path); dir !== "." && dir !== "/"; dir = dirname(dir)) {
    if (lstatOrNull(join(target, dir))?.isSymbolicLink()) {
      throw new Error(
        `${path}: its ancestor '${dir}' is a symbolic link, so the write could leave the checkout`,
      );
    }
  }
  return join(target, path);
}

/** The bytes at `path`, null when nothing is there; a directory or symlink
 *  at the path is refused loudly rather than read through or written over. */
export function existingFile(target: string, path: string): Buffer | null {
  const abs = insideTarget(target, path);
  const stat = lstatOrNull(abs);
  if (stat === null) return null;
  if (!stat.isFile()) {
    throw new Error(
      `${path}: not a regular file in the target repository; the writer will not replace it`,
    );
  }
  return readFileSync(abs);
}

export function writeFile(target: string, path: string, bytes: Buffer): void {
  const abs = insideTarget(target, path);
  const stat = lstatOrNull(abs);
  if (stat !== null && !stat.isFile()) {
    throw new Error(
      `${path}: not a regular file in the target repository; the writer will not replace it`,
    );
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

export function removeFile(target: string, path: string): void {
  unlinkSync(insideTarget(target, path));
}
