// Every read, write, and unlink the writer performs inside the target
// checkout goes through here. File APIs follow symbolic links, so a linked
// ancestor directory (docs -> ../shared) would carry a write or an unlink
// outside the checkout with the final path component looking clean; the
// final component itself is probed with lstat and never read through.

import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

/** What sits at a path: nothing, a regular file with its bytes, or a
 *  symbolic link with its target. Anything else (a directory, a device) is
 *  refused loudly: the writer has no honest way to replace it. */
export type Found =
  | { kind: "absent" }
  | { kind: "file"; bytes: Buffer }
  | { kind: "link"; target: string };

export function probe(target: string, path: string): Found {
  const abs = insideTarget(target, path);
  const stat = lstatOrNull(abs);
  if (stat === null) return { kind: "absent" };
  if (stat.isSymbolicLink()) return { kind: "link", target: readlinkSync(abs) };
  if (!stat.isFile()) {
    throw new Error(
      `${path}: not a regular file in the target repository; the writer will not replace it`,
    );
  }
  return { kind: "file", bytes: readFileSync(abs) };
}

/** What sits at a path, in the words a report row uses. */
export type Occupant =
  | "a regular file"
  | "a symbolic link"
  | "a directory"
  | "something that is not a regular file";

/** What sits at `path`, or null when nothing does. Nothing is read through,
 *  so a directory or a device is named for a hold instead of refused. */
export function occupant(target: string, path: string): Occupant | null {
  const stat = lstatOrNull(insideTarget(target, path));
  if (stat === null) return null;
  if (stat.isSymbolicLink()) return "a symbolic link";
  if (stat.isDirectory()) return "a directory";
  if (stat.isFile()) return "a regular file";
  return "something that is not a regular file";
}

/** The bytes at `path`, null when nothing is there; a directory or symlink
 *  at the path is refused loudly rather than read through or written over.
 *  For the files the writer must be able to trust as files (the manifest,
 *  the registration); the class writers probe instead. */
export function existingFile(target: string, path: string): Buffer | null {
  const found = probe(target, path);
  if (found.kind === "link") {
    throw new Error(
      `${path}: not a regular file in the target repository; the writer will not replace it`,
    );
  }
  return found.kind === "file" ? found.bytes : null;
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

/** Creates the symbolic link, replacing a link already there; a regular
 *  file or a directory at the path is refused (the caller removes a file
 *  it has judged its own first). */
export function writeLink(target: string, path: string, linkTarget: string): void {
  const abs = insideTarget(target, path);
  const stat = lstatOrNull(abs);
  if (stat !== null && !stat.isSymbolicLink()) {
    throw new Error(
      `${path}: not a symbolic link in the target repository; the writer will not replace it`,
    );
  }
  mkdirSync(dirname(abs), { recursive: true });
  if (stat !== null) unlinkSync(abs);
  symlinkSync(linkTarget, abs);
}

/** Removes the file or symbolic link at `path` (never what a link points at). */
export function removeFile(target: string, path: string): void {
  unlinkSync(insideTarget(target, path));
}

/** Removes the directory at `path` with everything under it. Only a
 *  directory is taken (a link to one is unlinked by removeFile, never
 *  walked), and links inside it are unlinked, never followed. */
export function removeTree(target: string, path: string): void {
  const abs = insideTarget(target, path);
  const stat = lstatOrNull(abs);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${path}: not a directory in the target repository; nothing to remove whole`);
  }
  rmSync(abs, { recursive: true });
}
