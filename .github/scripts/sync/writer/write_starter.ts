// `content` is rendered only on creation: a present starter is the repository's own and must not fail on missing placeholder values.

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
