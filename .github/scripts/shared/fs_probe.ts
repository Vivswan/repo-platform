// Filesystem existence probes that tell "nothing at this path" from
// "could not look": the sync's delivery legs decide what to write off an
// lstat, so a permission or I/O failure must fail the leg loudly, never
// read as an absent file (a stale mirror, a managed file reported as one
// the render lacks).

import { lstatSync, type Stats, statSync } from "node:fs";

/** Whether a filesystem error means "nothing at this path" (ENOENT, or a
 * file where a directory was expected - ENOTDIR). Anything else (EACCES,
 * EIO) is a broken runner, not an absent path. */
export function absentError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The lstat of `path`, null when nothing is there; any other lookup
 * failure rethrows. */
export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path) ?? null;
  } catch (err) {
    if (absentError(err)) return null;
    throw err;
  }
}

/** The stat of what `path` resolves to, links followed; null when the
 * resolution reaches nothing (an absent path, a dangling link, a link
 * loop). Any other failure rethrows. */
export function statOrNull(path: string): Stats | null {
  try {
    return statSync(path) ?? null;
  } catch (err) {
    if (absentError(err) || (err as { code?: string }).code === "ELOOP") return null;
    throw err;
  }
}
