// Managed files are written whole. A local edit (content that is neither
// the new content nor what the writer last recorded) is replaced anyway and
// reported with the text it replaced, so the report can show the diff and
// hold the PR for a human.

import { sha256 } from "./manifest.ts";
import { existingFile, writeFile } from "./target_files.ts";

export type WriteOutcome =
  | { change: "created" | "updated" | "unchanged" }
  | { change: "replaced local edits"; replaced: string };

export type Change = WriteOutcome["change"];

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
