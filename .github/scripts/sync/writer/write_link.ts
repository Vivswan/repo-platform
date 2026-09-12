import { sha256 } from "./manifest.ts";
import { writeLink as placeLink, probe } from "./target_files.ts";
import type { WriteOutcome } from "./write_managed.ts";

export function writeLink(
  target: string,
  path: string,
  linkTarget: string,
  recorded: string | null,
): WriteOutcome {
  const found = probe(target, path);
  if (found.kind === "file") {
    return { change: "held", reason: "a regular file sits where a link is declared" };
  }
  if (found.kind === "link" && found.target.equals(Buffer.from(linkTarget))) {
    return { change: "unchanged" };
  }
  placeLink(target, path, linkTarget);
  if (found.kind === "absent") return { change: "created" };
  if (recorded !== null && sha256(found.target) === recorded) return { change: "updated" };
  return { change: "replaced local edits", replaced: found.target.toString("utf-8") };
}
