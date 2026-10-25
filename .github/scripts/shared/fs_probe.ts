// The sync's delivery legs decide what to write off an lstat, so a permission or I/O failure must fail the leg loudly.
// Read as an absent file it would report a stale mirror, or a managed file as one the render lacks.

import { lstatSync, type Stats } from "node:fs";

/** ENOTDIR is absent too: a file sits where a path component expected a directory. */
export function absentError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path) ?? null;
  } catch (err) {
    if (absentError(err)) return null;
    throw err;
  }
}
