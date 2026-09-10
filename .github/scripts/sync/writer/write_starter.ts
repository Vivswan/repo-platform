// Starters are written once: an existing file or link, whatever it holds,
// is the repository's own from then on, and its source is rendered only
// when the file is created (a present starter needs no placeholder values).

import { probe, writeFile } from "./target_files.ts";
import type { WriteOutcome } from "./write_managed.ts";

export function writeStarter(
  target: string,
  path: string,
  content: () => string | { missing: string[] },
): WriteOutcome | { missing: string[] } {
  if (probe(target, path).kind !== "absent") return { change: "unchanged" };
  const rendered = content();
  if (typeof rendered !== "string") return rendered;
  writeFile(target, path, Buffer.from(rendered, "utf-8"));
  return { change: "created" };
}
