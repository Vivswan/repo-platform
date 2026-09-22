#!/usr/bin/env bun
// The overlay starter seeded `topics: ""` fleet-wide as the declare-and-clear spelling; the settings library now refuses
// an empty topic (GitHub accepts none) and takes `topics: []` for the same meaning, so this rung respells the seeded
// line in the overlays that still carry it. Any other value is the repository's own and stays.
// stdout is the runner's (sync/migrate.ts): the overlay's path when it was written, nothing otherwise.
//
// Usage: bun migrations/0003-topics-empty-list.ts <checkout>

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Document, isMap, isNode, isScalar, parseDocument } from "yaml";

const OVERLAY = ".github/settings.local.yml";
const RUNG = "0003-topics-empty-list";

export type Judgment =
  | { verdict: "absent" }
  | { verdict: "respelled"; text: string }
  | { verdict: "kept" }
  | { verdict: "refused"; reason: string };

type Overlay = { repository?: { topics?: unknown } | null };

/** Null when the text does not read as one document: a syntax error, or an alias its anchor no longer precedes,
 *  which the parser reports only when the value is read. An empty or comments-only file reads as `{}`. */
function readOverlay(text: string): { doc: Document; js: Overlay } | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  try {
    return { doc, js: (doc.toJS() ?? {}) as Overlay };
  } catch {
    return null;
  }
}

/** The value is judged resolved (an alias reads as what it names): `""`, whitespace, or no value at all is the seeded
 *  empty; anything else is the repository's own. The edit replaces the value alone and must read back as the original
 *  with `[]` in its place, or the line is left for a human. */
export function judgeOverlay(text: string): Judgment {
  const read = readOverlay(text);
  if (read === null) return { verdict: "absent" };
  const { doc, js: before } = read;
  const value = before.repository?.topics;
  if (value === undefined) return { verdict: "absent" };
  if (!(value === null || (typeof value === "string" && value.trim() === ""))) {
    return { verdict: "kept" };
  }
  const repositoryMap = doc.get("repository", true);
  const pair = isMap(repositoryMap)
    ? repositoryMap.items.find((item) => isScalar(item.key) && item.key.value === "topics")
    : undefined;
  const keyRange = pair !== undefined && isScalar(pair.key) ? pair.key.range : null;
  if (pair === undefined || keyRange == null) {
    return { verdict: "refused", reason: "its topics key is not written as a plain line" };
  }
  const node = isNode(pair.value) ? pair.value : null;
  // A valueless key parses to an empty node right after its colon, so the list gets the space the colon lacks.
  const valueStart = node?.range != null ? node.range[0] : keyRange[1] + 1;
  const valueEnd = node?.range != null ? node.range[1] : keyRange[1] + 1;
  // A block scalar's range runs to the end of its lines, comment and newline included, and the read-back below
  // compares values alone, so the edit is made only where the value sits on the key's line.
  if (/[\n#]/.test(text.slice(valueStart, valueEnd))) {
    return { verdict: "refused", reason: "its topics value is not written on the key's line" };
  }
  const spacer = valueStart === valueEnd ? " " : "";
  const edited = `${text.slice(0, valueStart)}${spacer}[]${text.slice(valueEnd)}`;
  const expected = { ...before, repository: { ...before.repository, topics: [] } };
  const after = readOverlay(edited);
  if (after === null || !isDeepStrictEqual(after.js, expected)) {
    return {
      verdict: "refused",
      reason: "respelling its topics value would change more than the topics",
    };
  }
  return { verdict: "respelled", text: edited };
}

function standing(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function main(checkout: string | undefined): number {
  if (checkout === undefined) {
    console.error("usage: bun migrations/0003-topics-empty-list.ts <checkout>");
    return 2;
  }
  // File APIs follow symbolic links, so a linked ancestor would carry the write outside the checkout (the writer's
  // insideTarget rule); a link at the overlay itself is left for the writer to refuse.
  for (let dir = dirname(OVERLAY); dir !== "."; dir = dirname(dir)) {
    if (standing(join(checkout, dir))?.isSymbolicLink()) {
      console.error(
        `${OVERLAY}: its ancestor '${dir}' is a symbolic link, so the write could leave the checkout`,
      );
      return 1;
    }
  }
  const path = join(checkout, OVERLAY);
  if (standing(path)?.isFile() !== true) return 0;
  const judged = judgeOverlay(readFileSync(path, "utf-8"));
  if (judged.verdict === "refused") {
    console.error(`${RUNG}: ${OVERLAY}: ${judged.reason}; settle the topics line by hand`);
    return 1;
  }
  if (judged.verdict !== "respelled") return 0;
  writeFileSync(path, judged.text);
  console.log(OVERLAY);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv[2]));
