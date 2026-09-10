// Starters are written once: an existing file, whatever it holds, is the
// repository's own from then on.

import { existingFile, type WriteOutcome, writeFile } from "./write_managed.ts";

export function writeStarter(target: string, path: string, content: string): WriteOutcome {
  if (existingFile(target, path) !== null) return { change: "unchanged" };
  writeFile(target, path, Buffer.from(content, "utf-8"));
  return { change: "created" };
}
