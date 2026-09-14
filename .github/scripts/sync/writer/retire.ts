import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RetiredEntry } from "../../../../actions/plan/files_config.ts";
import { cleanManagedRegion } from "../../../../actions/shared/grammar.ts";
import { capture } from "../../shared/proc.ts";
import { mirrorKind, type Records, readRecord, sha256 } from "./manifest.ts";
import { insideTarget, probe, removeFile, writeFile } from "./target_files.ts";

export type RetireOutcome = "deleted" | "region removed" | "moved" | "held" | "kept" | "released";

export interface RetireRow {
  path: string;
  outcome: RetireOutcome;
  detail: string;
}

/** unrecorded -> no record, or one readRecord refuses, so nothing at the path is the writer's to judge
 *  blank      -> a split whose region is the last write with only blank lines around it, so nothing is worth handing over
 *  A symbolic link is judged by its target string, never read through; under a record that is not a link or a symlink mirror it is foreign, as mirrors.ts reads it. */
export type Judgement =
  | { verdict: "unrecorded" }
  | { verdict: "own" }
  | { verdict: "blank" }
  | { verdict: "handover"; kept: Buffer }
  | { verdict: "foreign"; reason: string };

const foreign = (reason: string): Judgement => ({ verdict: "foreign", reason });

/** Lines with their terminators, so joining them gives the text back. */
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const blank = (line: string) => line.trim() === "";

/** The region usually opened the file, so blank lines that would lead a headless file go; every other byte is the repository's own and stays.
 *    content on both sides of the region -> the blank lines that framed it merge into one
 *    content on one side only            -> none */
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
  const record = readRecord(records[path]);
  if (record === null) return { verdict: "unrecorded" };
  if (record.class === "starter") return foreign("a starter is repo-owned");
  if (record.hash === null) return foreign("the record carries no hash");
  const linkRecorded =
    record.class === "link" || (record.class === "mirror" && mirrorKind(record) === "symlink");
  const found = probe(target, path);
  if (found.kind === "absent") return { verdict: "own" };
  if (linkRecorded) {
    if (found.kind !== "link") return foreign("a regular file sits where a link is recorded");
    return sha256(found.target) === record.hash
      ? { verdict: "own" }
      : foreign("the path is a symbolic link whose target is not the recorded one");
  }
  if (found.kind === "link")
    return foreign("a symbolic link sits where a regular file is recorded");
  if (record.class === "split") {
    // latin1 round-trips every byte, so the kept halves are the file's own.
    const text = found.bytes.toString("latin1");
    const slice = cleanManagedRegion(text, { begin: record.begin, end: record.end });
    if (slice === null) return foreign("the managed-region markers are missing or malformed");
    if (sha256(Buffer.from(slice.region, "latin1")) !== record.hash) {
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
  return sha256(found.bytes) === record.hash
    ? { verdict: "own" }
    : foreign("the content differs from the last write");
}

/** A class flip rewrites the whole file, so repository-owned content around a split region is as much a reason as any other; blank lines around it are not. */
export function keepReason(target: string, path: string, records: Records): string | null {
  const judgement = judge(target, path, records);
  if (judgement.verdict === "own" || judgement.verdict === "blank") return null;
  if (judgement.verdict === "unrecorded") return "no record of the platform writing it";
  if (judgement.verdict === "handover") {
    return "the file carries repository-owned content outside the managed region";
  }
  return judgement.reason;
}

/** The registration's `except` names the path the repository's own, so the record leaves and nothing at the path is
 *  probed or judged, whatever sits there. */
export function release(path: string, records: Records): RetireRow {
  delete records[path];
  return {
    path,
    outcome: "released",
    detail:
      "excepted by the registration; the record leaves and the file stays as it is, the repository's own",
  };
}

/** `git mv`, so the rename lands in the sync commit as one. */
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

/** `stale`: paths an earlier sync recorded that nothing selects now. */
export function retire(
  target: string,
  entries: RetiredEntry[],
  stale: string[],
  selected: ReadonlySet<string>,
  records: Records,
): RetireRow[] {
  const rows: RetireRow[] = [];
  const dispose = (path: string, detail: string) => {
    const judgement = judge(target, path, records);
    if (judgement.verdict === "unrecorded") return;
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
