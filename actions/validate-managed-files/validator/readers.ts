import { lstatSync } from "node:fs";

export function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** A conflict-marker line: 7 angles + space, or exactly 7 equals. Checked per line, CRLF included, so a checkout
 *  under core.autocrlf is read like any other (constructed, never literal - this file must pass its own scan). */
export function hasConflictMarker(content: string): boolean {
  const angleLeft = `${"<".repeat(7)} `;
  const angleRight = `${">".repeat(7)} `;
  const equals = "=".repeat(7);
  return content
    .split(/\r?\n/)
    .some((line) => line.startsWith(angleLeft) || line.startsWith(angleRight) || line === equals);
}
