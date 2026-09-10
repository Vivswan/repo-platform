// Retirement: a path files.yml no longer writes leaves the repository only
// when the file is still exactly what the writer recorded; anything else is
// held for a human. A `moved_to` path is `git mv`ed while its new home is
// absent, and its record travels with it so the following write sees the
// moved file as the writer's own.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cleanManagedRegion } from "../../../../actions/shared/grammar.ts";
import { capture } from "../../shared/proc.ts";
import type { RetiredEntry } from "./files_config.ts";
import { type Records, recordedHash, sha256 } from "./manifest.ts";
import { existingFile, insideTarget, removeFile } from "./target_files.ts";

export type RetireOutcome = "deleted" | "moved" | "held" | "kept";

export interface RetireRow {
  path: string;
  outcome: RetireOutcome;
  detail: string;
}

/** Why the file at `path` is not exactly the writer's last write, or null
 *  when it is (and may be deleted). */
export function keepReason(target: string, path: string, records: Records): string | null {
  const entry = records[path];
  if (entry === undefined) return "no record of the platform writing it";
  if (entry.class === "starter") return "a starter is repo-owned";
  const hash = recordedHash(records, path);
  if (hash === null) return "the record carries no hash";
  const bytes = existingFile(target, path);
  if (bytes === null) return null;
  if (entry.class === "split") {
    if (typeof entry.begin !== "string" || typeof entry.end !== "string") {
      return "the split record names no markers";
    }
    const text = bytes.toString("latin1");
    const slice = cleanManagedRegion(text, { begin: entry.begin, end: entry.end });
    if (slice === null) return "the managed-region markers are missing or malformed";
    if (sha256(Buffer.from(slice.region, "latin1")) !== hash)
      return "the managed region was edited";
    if (slice.above.trim() !== "" || slice.below.trim() !== "") {
      return "the file carries repository-owned content outside the managed region";
    }
    return null;
  }
  return sha256(bytes) === hash ? null : "the content differs from the last write";
}

function gitMove(target: string, from: string, to: string): void {
  insideTarget(target, from);
  mkdirSync(dirname(insideTarget(target, to)), { recursive: true });
  const result = capture(["git", "-C", target, "mv", "--", from, to]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git mv ${from} ${to} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

/** Retires the listed entries and the `stale` recorded paths (written by an
 *  earlier sync, selected by nothing now). A `moved_to` whose destination
 *  is not among the `selected` paths is a plain retirement: the platform no
 *  longer wants the file here at all. Records move with a moved file and
 *  leave with a deleted one. Rows are emitted only for files present. */
export function retire(
  target: string,
  entries: RetiredEntry[],
  stale: string[],
  selected: ReadonlySet<string>,
  records: Records,
): RetireRow[] {
  const rows: RetireRow[] = [];
  const dispose = (path: string, detail: string) => {
    const reason = keepReason(target, path, records);
    if (reason === null) {
      removeFile(target, path);
      delete records[path];
      rows.push({ path, outcome: "deleted", detail });
    } else if (records[path]?.class === "starter") {
      rows.push({ path, outcome: "kept", detail: reason });
    } else {
      rows.push({ path, outcome: "held", detail: reason });
    }
  };
  for (const entry of entries) {
    if (existingFile(target, entry.path) === null) continue;
    if (entry.moved_to !== undefined && !selected.has(entry.moved_to)) {
      dispose(entry.path, `retired (its new home ${entry.moved_to} is not selected here)`);
      continue;
    }
    if (entry.moved_to !== undefined) {
      if (existingFile(target, entry.moved_to) === null) {
        gitMove(target, entry.path, entry.moved_to);
        if (records[entry.path] !== undefined) {
          records[entry.moved_to] = records[entry.path];
          delete records[entry.path];
        }
        rows.push({ path: entry.path, outcome: "moved", detail: `to ${entry.moved_to}` });
      } else {
        rows.push({
          path: entry.path,
          outcome: "held",
          detail: `${entry.moved_to} already exists, so the file was not moved over it`,
        });
      }
      continue;
    }
    dispose(entry.path, "retired");
  }
  for (const path of stale) {
    if (existingFile(target, path) !== null) dispose(path, "no longer selected");
  }
  return rows;
}
