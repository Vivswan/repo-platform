// Managed files are written whole. A local edit (content that is neither
// the new content nor what the writer last recorded) is replaced anyway and
// reported with the text it replaced, so the report can show the diff and
// hold the PR for a human. A symbolic link at the path is held: the writer
// never reads through it and has no record of writing it as a file.

import { sha256 } from "./manifest.ts";
import { probe, writeFile } from "./target_files.ts";

export type WriteOutcome =
  | { change: "created" | "updated" | "unchanged" | "region added" }
  | { change: "replaced local edits"; replaced: string }
  | { change: "held"; reason: string };

export type Change = WriteOutcome["change"];

export const LINK_IN_THE_WAY = "a symbolic link sits where a file is declared";

export function writeManaged(
  target: string,
  path: string,
  content: string,
  recorded: string | null,
): WriteOutcome {
  const bytes = Buffer.from(content, "utf-8");
  const found = probe(target, path);
  if (found.kind === "link") return { change: "held", reason: LINK_IN_THE_WAY };
  if (found.kind === "absent") {
    writeFile(target, path, bytes);
    return { change: "created" };
  }
  if (found.bytes.equals(bytes)) return { change: "unchanged" };
  writeFile(target, path, bytes);
  if (recorded !== null && sha256(found.bytes) === recorded) return { change: "updated" };
  return { change: "replaced local edits", replaced: found.bytes.toString("utf-8") };
}
