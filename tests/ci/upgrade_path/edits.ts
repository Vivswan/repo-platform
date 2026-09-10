// Text edits that model a build tree's past shape. Each one fails loud,
// naming `what`, when its anchor is missing or ambiguous: a fixture edit
// that silently did nothing would leave a later assertion vacuous.

import { readFileSync, writeFileSync } from "node:fs";

export function editText(path: string, edit: (text: string) => string): void {
  writeFileSync(path, edit(readFileSync(path, "utf-8")));
}

export function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** `text` with the ONE occurrence of `needle` replaced. */
export function replaceOnce(
  text: string,
  needle: string,
  replacement: string,
  what: string,
): string {
  const count = countOf(text, needle);
  if (count !== 1) throw new Error(`${what}: expected exactly one occurrence, found ${count}`);
  return text.replace(needle, () => replacement);
}

/** The lines of `text`, a trailing newline yielding no empty last line. */
export function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const joinLines = (lines: string[]): string => `${lines.join("\n")}\n`;

/** `text` with `inserted` placed right after the first line `matches`. */
export function insertAfterLine(
  text: string,
  matches: (line: string) => boolean,
  inserted: string[],
  what: string,
): string {
  const lines = linesOf(text);
  const at = lines.findIndex(matches);
  if (at === -1) throw new Error(`${what}: anchor line not found`);
  lines.splice(at + 1, 0, ...inserted);
  return joinLines(lines);
}

/** `text` with `inserted` placed right before the first line `matches`. */
export function insertBeforeLine(
  text: string,
  matches: (line: string) => boolean,
  inserted: string[],
  what: string,
): string {
  const lines = linesOf(text);
  const at = lines.findIndex(matches);
  if (at === -1) throw new Error(`${what}: anchor line not found`);
  lines.splice(at, 0, ...inserted);
  return joinLines(lines);
}

/** `text` without every line containing `needle`. */
export function dropLinesContaining(text: string, needle: string): string {
  return joinLines(linesOf(text).filter((line) => !line.includes(needle)));
}
