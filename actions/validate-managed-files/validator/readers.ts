import { lstatSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The shape of a YAML file for the structural checks, which need its
 *  content rather than its verdict: duplicate keys are tolerated here
 *  because the yaml check already reports them, and a second, wrong
 *  diagnostic (a registration with `modules` written twice is not a
 *  registration missing `modules`) must not ride on top. */
export function shapeOfYaml(text: string): unknown {
  return parseYaml(text, { uniqueKeys: false });
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
