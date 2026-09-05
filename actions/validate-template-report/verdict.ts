// The integrity leg's ONE verdict per run: the child's exit and the report
// files it wrote are two witnesses to one event, and a pair that disagrees
// is `not-judged`, never a pass.

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import type { ChildExit } from "./runtime.ts";

export type Integrity =
  | { kind: "clean"; advisories: string }
  | { kind: "findings"; findings: string; advisories: string }
  | { kind: "not-judged"; reason: string };

/** A report file's text with trailing newlines stripped, or null when the
 *  validator never wrote it. Only a regular file counts: a directory, a
 *  device, or a link planted at the path (a read of /dev/null would pass
 *  as an empty findings file) is absent. */
function reportText(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, "utf8").replace(/\n+$/, "");
  } catch {
    return null;
  }
}

/** The verdict a validator run earns. `deadlineMs` names the run's own
 *  deadline in the timeout reason. */
export function classify(
  exit: ChildExit,
  deadlineMs: number,
  files: { findings: string; advisories: string },
): Integrity {
  switch (exit.kind) {
    case "timed-out":
      return {
        kind: "not-judged",
        reason: `the validator ran past its ${deadlineMs / 1000}s deadline`,
      };
    case "signaled":
      return { kind: "not-judged", reason: `the validator died on ${exit.signal}` };
    case "exited":
      return judgeReports(exit.code, files);
  }
}

function judgeReports(code: number, files: { findings: string; advisories: string }): Integrity {
  const findings = reportText(files.findings);
  const advisories = reportText(files.advisories);
  if (findings === null || advisories === null) {
    return { kind: "not-judged", reason: `the validator exited ${code} before reporting` };
  }
  if (code === 0 && findings !== "") {
    return { kind: "not-judged", reason: "the validator exited 0 yet reported findings" };
  }
  if (code !== 0 && findings === "") {
    return {
      kind: "not-judged",
      reason: `the validator exited ${code} without reporting a finding`,
    };
  }
  return code === 0 ? { kind: "clean", advisories } : { kind: "findings", findings, advisories };
}

/** The one byte form of a verdict: each variant's keys in a fixed order,
 *  whatever order a writer built its object in. */
function serialized(verdict: Integrity): string {
  let ordered: Record<string, string>;
  switch (verdict.kind) {
    case "clean":
      ordered = { kind: verdict.kind, advisories: verdict.advisories };
      break;
    case "findings":
      ordered = { kind: verdict.kind, findings: verdict.findings, advisories: verdict.advisories };
      break;
    case "not-judged":
      ordered = { kind: verdict.kind, reason: verdict.reason };
      break;
  }
  return `${JSON.stringify(ordered)}\n`;
}

export function writeVerdict(path: string, verdict: Integrity): void {
  writeFileSync(path, serialized(verdict));
}

/** The verdict a step wrote, or `not-judged` when there is none to read.
 *  Only writeVerdict's own bytes are a verdict: the parsed value must print
 *  back to the file exactly, so a duplicate key or a stray field (which
 *  JSON.parse would quietly resolve) is not one. */
export function readVerdict(path: string): Integrity {
  const none: Integrity = {
    kind: "not-judged",
    reason: "the aligned validator step wrote no verdict",
  };
  let text: string;
  let parsed: unknown;
  try {
    text = readFileSync(path, "utf8");
    parsed = JSON.parse(text);
  } catch {
    return none;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return none;
  const record = parsed as Record<string, unknown>;
  const shape = (...keys: string[]): boolean =>
    Object.keys(record).sort().join(",") === ["kind", ...keys].sort().join(",") &&
    keys.every((key) => typeof record[key] === "string");
  let verdict: Integrity | null = null;
  if (record.kind === "clean" && shape("advisories")) {
    verdict = { kind: "clean", advisories: record.advisories as string };
  } else if (
    record.kind === "findings" &&
    shape("findings", "advisories") &&
    record.findings !== ""
  ) {
    verdict = {
      kind: "findings",
      findings: record.findings as string,
      advisories: record.advisories as string,
    };
  } else if (record.kind === "not-judged" && shape("reason") && record.reason !== "") {
    verdict = { kind: "not-judged", reason: record.reason as string };
  }
  return verdict !== null && serialized(verdict) === text ? verdict : none;
}
