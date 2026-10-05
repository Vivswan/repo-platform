// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import { MANAGED_HEADER_PATTERN } from "./platform.ts";

/** Only the first lines are a header, and only comment lines count: a string literal or a shell `echo` carrying the
 *  managed sentence is code, so a repo-owned file cannot exempt itself by printing it. */
const HEADER_LINES = 10;
export const COMMENT_LINE = /^\s*(#|\/\/|\/\*|\*|<!--|--|;|%|\{#|"""|''')/;

export function headerLines(text: string): string[] {
  return text.split("\n", HEADER_LINES);
}

/** A file the platform's sync writes; the repository that holds it cannot fix it, so a check skips and counts it. */
export function isManaged(text: string): boolean {
  return headerLines(text).some(
    (line) => COMMENT_LINE.test(line) && MANAGED_HEADER_PATTERN.test(line),
  );
}
