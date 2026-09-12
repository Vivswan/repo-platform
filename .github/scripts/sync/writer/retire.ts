// Retirement: a path files.yml no longer writes leaves the repository only
// when the file is still exactly what the writer recorded; anything else
// recorded is held for a human, and an unrecorded file there is not the
// platform's to retire. A split file whose region is the recorded write but
// which carries repository-owned content around it is handed over once: the
// region and its marker lines go, the rest stays as a plain file joined
// without the blank lines the region left behind, and the record leaves
// with the region, so the next run has no claim on the path.
// A `moved_to` path is `git mv`ed while its new home is absent, and its
// record travels with it so the following write sees the moved file as the
// writer's own.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RetiredEntry } from "../../../../actions/plan/files_config.ts";
import { cleanManagedRegion } from "../../../../actions/shared/grammar.ts";
import { capture } from "../../shared/proc.ts";
import { type Records, recordedHash, sha256 } from "./manifest.ts";
import { insideTarget, probe, removeFile, writeFile } from "./target_files.ts";

export type RetireOutcome = "deleted" | "region removed" | "moved" | "held" | "kept";

export interface RetireRow {
  path: string;
  outcome: RetireOutcome;
  detail: string;
}

/** What sits at a path against the writer's last write.
 *  `blank`: a split whose region is the last write with only blank lines around it, so nothing is worth handing over.
 *  A symbolic link is judged by its target string, never read through, whatever class the record names. */
export type Judgement =
  | { verdict: "own" }
  | { verdict: "blank" }
  | { verdict: "handover"; kept: Buffer }
  | { verdict: "foreign"; reason: string };

const foreign = (reason: string): Judgement => ({ verdict: "foreign", reason });

/** Lines with their terminators, so joining them gives the text back. */
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const blank = (line: string) => line.trim() === "";

/** The halves around a removed region as one plain file.
 *  The region usually opened the file, so the blank lines the tail began with would lead a headless file: they go.
 *  Blank lines that framed a mid-file region merge into one, and into none when content stands on one side only.
 *  Every other byte is the repository's own and stays. */
export function joinHalves(above: string, below: string): string {
  const head = lines(above);
  const tail = lines(below);
  const contentEnd = head.findLastIndex((line) => !blank(line)) + 1;
  const contentStart = tail.findIndex((line) => !blank(line));
  if (contentStart === -1) return head.slice(0, contentEnd).join("");
  const seam = [...head.slice(contentEnd), ...tail.slice(0, contentStart)];
  const gap = contentEnd > 0 ? seam.slice(0, 1) : [];
  return [...head.slice(0, contentEnd), ...gap, ...tail.slice(contentStart)].join("");
}

export function judge(target: string, path: string, records: Records): Judgement {
  const entry = records[path];
  if (entry === undefined) return foreign("no record of the platform writing it");
  if (entry.class === "starter") return foreign("a starter is repo-owned");
  const hash = recordedHash(records, path);
  if (hash === null) return foreign("the record carries no hash");
  const found = probe(target, path);
  if (found.kind === "absent") return { verdict: "own" };
  if (found.kind === "link") {
    return sha256(found.target) === hash
      ? { verdict: "own" }
      : foreign("the path is a symbolic link whose target is not the recorded one");
  }
  if (entry.class === "link") return foreign("a regular file sits where the platform wrote a link");
  if (entry.class === "split") {
    if (typeof entry.begin !== "string" || typeof entry.end !== "string") {
      return foreign("the split record names no markers");
    }
    // latin1 round-trips every byte, so the kept halves are the file's own.
    const text = found.bytes.toString("latin1");
    const slice = cleanManagedRegion(text, { begin: entry.begin, end: entry.end });
    if (slice === null) return foreign("the managed-region markers are missing or malformed");
    if (sha256(Buffer.from(slice.region, "latin1")) !== hash) {
      return foreign("the managed region was edited");
    }
    if (slice.above.trim() === "" && slice.below.trim() === "") {
      return slice.above === "" && slice.below === "" ? { verdict: "own" } : { verdict: "blank" };
    }
    return {
      verdict: "handover",
      kept: Buffer.from(joinHalves(slice.above, slice.below), "latin1"),
    };
  }
  return sha256(found.bytes) === hash
    ? { verdict: "own" }
    : foreign("the content differs from the last write");
}

/** Why what sits at `path` may not be replaced whole, or null when it is
 *  exactly the writer's last write. For a class flip, which rewrites the
 *  whole file, repository-owned content around a split region is as much
 *  a reason as any other; blank lines around it are not. */
export function keepReason(target: string, path: string, records: Records): string | null {
  const judgement = judge(target, path, records);
  if (judgement.verdict === "own" || judgement.verdict === "blank") return null;
  if (judgement.verdict === "handover") {
    return "the file carries repository-owned content outside the managed region";
  }
  return judgement.reason;
}

/** `git mv` inside the target, so the rename lands in the sync commit as
 *  one; the destination's directory is made first. */
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
 *  leave with a deleted one and with a removed region. Rows are emitted
 *  only for files present; a move to a selected home happens whatever the
 *  record says, and any other unrecorded file is not the platform's to
 *  retire and gets no row. */
export function retire(
  target: string,
  entries: RetiredEntry[],
  stale: string[],
  selected: ReadonlySet<string>,
  records: Records,
): RetireRow[] {
  const rows: RetireRow[] = [];
  const dispose = (path: string, detail: string) => {
    if (records[path] === undefined) return;
    const judgement = judge(target, path, records);
    if (judgement.verdict === "own" || judgement.verdict === "blank") {
      removeFile(target, path);
      delete records[path];
      const note =
        judgement.verdict === "blank" ? "; only blank lines sat outside the managed region" : "";
      rows.push({ path, outcome: "deleted", detail: `${detail}${note}` });
    } else if (judgement.verdict === "handover") {
      writeFile(target, path, judgement.kept);
      delete records[path];
      rows.push({
        path,
        outcome: "region removed",
        detail: `${detail}; repository-owned content kept as a plain file; the region is gone, so read the file whole, give it a heading and intro if it lost them, or delete it`,
      });
    } else if (records[path]?.class === "starter") {
      rows.push({ path, outcome: "kept", detail: judgement.reason });
    } else {
      rows.push({ path, outcome: "held", detail: judgement.reason });
    }
  };
  const present = (path: string) => probe(target, path).kind !== "absent";
  for (const entry of entries) {
    if (!present(entry.path)) continue;
    if (entry.moved_to !== undefined && !selected.has(entry.moved_to)) {
      dispose(entry.path, `retired (its new home ${entry.moved_to} is not selected here)`);
      continue;
    }
    if (entry.moved_to !== undefined) {
      if (!present(entry.moved_to)) {
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
    if (present(path)) dispose(path, "no longer selected");
  }
  return rows;
}
