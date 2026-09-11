// The displacement pass: an entry whose class flipped from starter to
// managed (`displaces` in files.yml) finds the repository's own file at
// its path. Before the write loop, that file moves verbatim to the
// starter path it displaces, comments and all, and its record follows as
// a starter; the rendered content is then created at the freed path. A
// path with any other record is left to the ordinary flip rule.

import type { FileEntry } from "../../../../actions/plan/files_config.ts";
import type { Records } from "./manifest.ts";
import { gitMove } from "./retire.ts";
import { probe } from "./target_files.ts";

export type Displacement =
  | { path: string; outcome: "moved"; to: string }
  | { path: string; outcome: "held"; detail: string };

/** Moves each displacing entry's repository-owned file aside when its new
 *  home is free, records the move, and reports a home already taken as a
 *  hold; `records` is updated in place. */
export function displace(target: string, entries: FileEntry[], records: Records): Displacement[] {
  const rows: Displacement[] = [];
  for (const entry of entries) {
    if (entry.class !== "managed" || entry.displaces === undefined) continue;
    const to = entry.displaces;
    if (probe(target, entry.path).kind !== "file") continue;
    const record = records[entry.path];
    if (record !== undefined && record.class !== "starter") continue;
    if (probe(target, to).kind !== "absent") {
      rows.push({
        path: entry.path,
        outcome: "held",
        detail: `class changed from starter to managed, and ${to} already exists, so the file was not moved over it`,
      });
      continue;
    }
    gitMove(target, entry.path, to);
    records[to] = { class: "starter" };
    delete records[entry.path];
    rows.push({ path: entry.path, outcome: "moved", to });
  }
  return rows;
}
