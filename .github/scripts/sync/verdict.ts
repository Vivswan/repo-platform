#!/usr/bin/env bun
// The only lines sync-repos.yml prints on its own behalf; everything else a run learns goes to $RUNNER_TEMP files or the target
// repository (docs/platform/sync/operator.md).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setOutput } from "@actions/core";
import { env, requireEnv } from "../shared/gha.ts";

export const DELIVERY_VERDICTS = ["unchanged", "opened", "refreshed", "pushed", "failed"] as const;
export type DeliveryVerdict = (typeof DELIVERY_VERDICTS)[number];

/** The deliver step's verdict, in RUNNER_TEMP, which the plan's summary reads. */
export const VERDICT_FILE = "verdict.txt";

/** The selector's rows ({repo, private}, real slugs) in RUNNER_TEMP, which the plan counts. */
export const ROWS_FILE = "rows.json";

/** The row line for a plan row whose deliver step never ran. */
export const UNRESOLVED = "failed before the target was resolved; re-run the workflow";

/** The row line's tail per verdict. */
export const ROW_LINES: Record<DeliveryVerdict, string> = {
  unchanged: "unchanged",
  opened: "PR opened",
  refreshed: "PR refreshed",
  pushed: "branch pushed",
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
  if (!existsSync(file)) {
    return 1;
  }
  const count = rowCount(readFileSync(file, "utf-8"));
  if (count < 0) {
    return 1;
  }
  setOutput("count", String(count));
  console.log(planLine(count));
  return 0;
}

function row(): number {
  const index = Number(requireEnv("ROW"));
  if (!Number.isInteger(index) || index < 0) {
    return 1;
  }
  if (env("TARGET") === "") {
    console.log(rowLine(index, UNRESOLVED));
    return 0;
  }
  const file = join(requireEnv("RUNNER_TEMP"), VERDICT_FILE);
  if (!existsSync(file)) {
    return 1;
  }
  const verdict = readFileSync(file, "utf-8").trim();
  if (!isDeliveryVerdict(verdict)) {
    return 1;
  }
  console.log(rowLine(index, ROW_LINES[verdict]));
  return 0;
}

function main(argv: string[]): number {
  if (argv.length !== 1) {
    return 2;
  }
  if (argv[0] === "plan") {
    return plan();
  }
  if (argv[0] === "row") {
    return row();
  }
  return 2;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
