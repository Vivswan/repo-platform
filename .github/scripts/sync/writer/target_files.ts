// File APIs follow symbolic links, so a linked ancestor (docs -> ../shared) would carry a write or an unlink outside the checkout; every ancestor is checked with lstat, and the final component is never read through.

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

/** The link target is raw bytes, as the mirror writer and the validator hash it: decoding would fold a malformed target onto the replacement character and let it pass as the recorded one. */
export type Found =
  | { kind: "absent" }
  | { kind: "file"; bytes: Buffer }
  | { kind: "link"; target: Buffer };

export function probe(target: string, path: string): Found {
  const abs = insideTarget(target, path);
  const stat = lstatOrNull(abs);
  if (stat === null) return { kind: "absent" };
  if (stat.isSymbolicLink()) {
    return { kind: "link", target: readlinkSync(abs, { encoding: "buffer" }) };
  }
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

/** Unlike probe, a directory or a device is named for a hold instead of refused. */
export function occupant(target: string, path: string): Occupant | null {
  const stat = lstatOrNull(insideTarget(target, path));
  if (stat === null) return null;
  if (stat.isSymbolicLink()) return "a symbolic link";
  if (stat.isDirectory()) return "a directory";
  if (stat.isFile()) return "a regular file";
  return "something that is not a regular file";
}

/** For the files the writer must trust as files (the manifest, the registration); the class writers probe instead. */
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

/** A regular file at the path is refused; the caller removes one it has judged its own first. */
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

export function removeFile(target: string, path: string): void {
  unlinkSync(insideTarget(target, path));
}

/** A link to a directory is refused: removeFile unlinks it instead of walking through. */
export function removeTree(target: string, path: string): void {
  const abs = insideTarget(target, path);
  const stat = lstatOrNull(abs);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${path}: not a directory in the target repository; nothing to remove whole`);
  }
  rmSync(abs, { recursive: true });
}
