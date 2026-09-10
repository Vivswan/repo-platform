// Starters are written once: an existing file or link, whatever it holds,
// is the repository's own from then on.

import { probe, writeFile } from "./target_files.ts";
import type { WriteOutcome } from "./write_managed.ts";

export function writeStarter(target: string, path: string, content: string): WriteOutcome {
  if (probe(target, path).kind !== "absent") return { change: "unchanged" };
  writeFile(target, path, Buffer.from(content, "utf-8"));
  return { change: "created" };
}
