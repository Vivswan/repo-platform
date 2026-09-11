#!/usr/bin/env bun
// The operator's log vocabulary: the only lines sync-repos.yml prints on
// its own behalf. Everything else a run learns goes to $RUNNER_TEMP files
// or to the target repository (docs/sync.md, "The operator").
//
// plan: the selector's rows file in RUNNER_TEMP -> "plan: <N> rows",
//   outputs count and indexes ([0..N-1], the matrix).
// row: env ROW, TARGET (empty when no step resolved the target), RUNNER_TEMP
//   -> one "row <i>: ..." line from the verdict deliver.ts wrote; a resolved
//   target with no verdict exits 1 silently (the delivery channel broke).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env, requireEnv, setOutput } from "../shared/gha.ts";

/** What deliver.ts records for a row, one word in VERDICT_FILE. */
export const DELIVERY_VERDICTS = ["unchanged", "opened", "refreshed", "failed"] as const;
export type DeliveryVerdict = (typeof DELIVERY_VERDICTS)[number];

export const VERDICT_FILE = "verdict.txt";

/** The selector's rows ({repo, private}, real slugs) in RUNNER_TEMP: the
 *  plan counts them, the row resolver reads its own. */
export const ROWS_FILE = "rows.json";

export const UNRESOLVED = "failed before the target was resolved; re-run the workflow";

/** The row line's tail per delivery verdict. */
export const ROW_LINES: Record<DeliveryVerdict, string> = {
  unchanged: "unchanged",
  opened: "PR opened",
  refreshed: "PR refreshed",
  failed: "failed, report filed in the target repository",
};

export function planLine(count: number): string {
  return `plan: ${count} rows`;
}

export function rowLine(index: number, tail: string): string {
  return `row ${index}: ${tail}`;
}

export function isDeliveryVerdict(value: string): value is DeliveryVerdict {
  return (DELIVERY_VERDICTS as readonly string[]).includes(value);
}

function rowCount(rows: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rows);
  } catch {
    return -1;
  }
  return Array.isArray(parsed) ? parsed.length : -1;
}

function plan(): number {
  const file = join(requireEnv("RUNNER_TEMP"), ROWS_FILE);
  if (!existsSync(file)) return 1;
  const count = rowCount(readFileSync(file, "utf-8"));
  if (count < 0) return 1;
  setOutput("count", String(count));
  setOutput("indexes", JSON.stringify([...Array(count).keys()]));
  console.log(planLine(count));
  return 0;
}

function row(): number {
  const index = Number(requireEnv("ROW"));
  if (!Number.isInteger(index) || index < 0) return 1;
  if (env("TARGET") === "") {
    console.log(rowLine(index, UNRESOLVED));
    return 0;
  }
  const file = join(requireEnv("RUNNER_TEMP"), VERDICT_FILE);
  if (!existsSync(file)) return 1;
  const verdict = readFileSync(file, "utf-8").trim();
  if (!isDeliveryVerdict(verdict)) return 1;
  console.log(rowLine(index, ROW_LINES[verdict]));
  return 0;
}

function main(argv: string[]): number {
  if (argv.length !== 1) return 2;
  if (argv[0] === "plan") return plan();
  if (argv[0] === "row") return row();
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
