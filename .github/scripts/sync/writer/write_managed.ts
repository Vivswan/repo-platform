// Managed files are written whole. A local edit (content that is neither
// the new content nor what the writer last recorded) is replaced anyway and
// reported with the text it replaced, so the report can show the diff and
// hold the PR for a human.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lstatOrNull } from "../../shared/fs_probe.ts";
import { sha256 } from "./manifest.ts";

export type WriteOutcome =
  | { change: "created" | "updated" | "unchanged" }
  | { change: "replaced local edits"; replaced: string };

export type Change = WriteOutcome["change"];

/** The bytes at `path` under `target`, null when nothing is there; a
 *  directory or symlink is refused loudly rather than written over. */
export function existingFile(target: string, path: string): Buffer | null {
  const abs = join(target, path);
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
  const abs = join(target, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

export function writeManaged(
  target: string,
  path: string,
  content: string,
  recorded: string | null,
): WriteOutcome {
  const bytes = Buffer.from(content, "utf-8");
  const existing = existingFile(target, path);
  if (existing === null) {
    writeFile(target, path, bytes);
    return { change: "created" };
  }
  if (existing.equals(bytes)) return { change: "unchanged" };
  writeFile(target, path, bytes);
  if (recorded !== null && sha256(existing) === recorded) return { change: "updated" };
  return { change: "replaced local edits", replaced: existing.toString("utf-8") };
}
