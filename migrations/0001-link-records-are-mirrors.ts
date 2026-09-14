#!/usr/bin/env bun
// The fleet's AGENTS.md symlinks became mirrors the fleet declares, and the writer refuses a manifest record of the
// class that left; this rung restamps each `link` record as the symlink mirror record the mirror pass writes, hash kept.
//
// Usage: bun migrations/0001-link-records-are-mirrors.ts <checkout>

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The manifest's name at this rung's time: a later rename is a later rung, run after this one.
const MANIFEST = ".github/repo-platform-manifest.json";

/** One record per line, as the writer prints it; the path stays as quoted, the hash as written. */
const LINK_RECORD = /^(\s*"(?:[^"\\]|\\.)*": )\{"class": "link", ("hash": [^}]*)\}(,?)$/gm;

export function restampLinkRecords(text: string): { text: string; restamped: number } {
  let restamped = 0;
  const next = text.replace(LINK_RECORD, (_line, head: string, hash: string, comma: string) => {
    restamped += 1;
    return `${head}{"class": "mirror", "kind": "symlink", ${hash}}${comma}`;
  });
  return { text: next, restamped };
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
    console.error("usage: bun migrations/0001-link-records-are-mirrors.ts <checkout>");
    return 2;
  }
  // File APIs follow symbolic links, so a linked ancestor would carry the write outside the checkout (the writer's
  // insideTarget rule); a link at the manifest itself is left for the writer to refuse.
  for (let dir = dirname(MANIFEST); dir !== "."; dir = dirname(dir)) {
    if (standing(join(checkout, dir))?.isSymbolicLink()) {
      console.error(
        `${MANIFEST}: its ancestor '${dir}' is a symbolic link, so the write could leave the checkout`,
      );
      return 1;
    }
  }
  const path = join(checkout, MANIFEST);
  if (standing(path)?.isFile() !== true) return 0;
  const { text, restamped } = restampLinkRecords(readFileSync(path, "utf-8"));
  if (restamped === 0) return 0;
  writeFileSync(path, text);
  console.log(
    `0001-link-records-are-mirrors: restamped ${restamped} link record(s) in ${MANIFEST}`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv[2]));
