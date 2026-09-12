#!/usr/bin/env bun
// The one step of a sync row that sees the target's name in the clear.
// The row job re-runs discovery and selection (the same scripts the plan
// job ran, their output in $RUNNER_TEMP files) and this step finds the row
// carrying the plan's key in the selector's rows file. Before anything
// else reaches stdout, every form of the name is registered with the
// runner's masker; the name then leaves this step only through GITHUB_ENV
// (TARGET, TARGET_PRIVATE), which the runner never echoes.
//
// Env: ROW_KEY (the plan's key for this row), PAT and GITHUB_RUN_ID (the
// key's inputs), RUNNER_TEMP (the rows file), GITHUB_ENV.

import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { addMask, fail, requireEnv } from "../shared/gha.ts";
import { parseJson, parseWith } from "../shared/json.ts";
import { maskForms } from "../shared/mask.ts";
import { ROWS_FILE } from "./verdict.ts";

/** A selector row: the repository and its visibility. */
const planRowSchema = z.object({ repo: z.string().min(1), private: z.boolean() });
export type PlanRow = z.infer<typeof planRowSchema>;

/** A row's identity as the public matrix carries it: an HMAC of the slug under the fleet token and
 *  the run id. Without the token it names nothing, and the same repository keys differently in
 *  every run, so a private row rides the matrix and the step env unnamed. */
export function rowKeyOf(pat: string, runId: string): (repo: string) => string {
  return (repo) => createHmac("sha256", pat).update(`${runId}\n${repo}`).digest("hex");
}

/** The plan job's matrix: an index for the job name, a key for the resolver. */
export function planMatrix(
  rows: PlanRow[],
  keyOf: (repo: string) => string,
): { include: { row: number; key: string }[] } {
  return { include: rows.map((row, index) => ({ row: index, key: keyOf(row.repo) })) };
}

/** The re-run selection's row carrying the plan's key, or a refusal naming no repository: a
 *  repository that left the fleet or un-adopted since the plan has no row here, and the rows
 *  around it moving neither adds nor shifts one. */
export function resolveRow(
  rows: PlanRow[],
  key: string,
  keyOf: (repo: string) => string,
): { target: PlanRow } | { refusal: string } {
  const target = rows.find((row) => keyOf(row.repo) === key);
  if (target === undefined) {
    return {
      refusal:
        "the row no longer names a repository the plan selected: the selection changed since the plan job ran (the fleet or a repository's registration moved mid-run)",
    };
  }
  return { target };
}

function main(): void {
  const runnerTemp = requireEnv("RUNNER_TEMP");
  const rows = parseWith(
    z.array(planRowSchema),
    parseJson(readFileSync(join(runnerTemp, ROWS_FILE), "utf-8"), "resolve_row: rows"),
    "resolve_row: rows",
  );
  const keyOf = rowKeyOf(requireEnv("PAT"), requireEnv("GITHUB_RUN_ID"));
  const resolved = resolveRow(rows, requireEnv("ROW_KEY"), keyOf);
  if ("refusal" in resolved) fail(`${resolved.refusal}; re-run the workflow`);
  for (const form of maskForms(resolved.target.repo)) addMask(form);
  appendFileSync(
    requireEnv("GITHUB_ENV"),
    `TARGET=${resolved.target.repo}\nTARGET_PRIVATE=${resolved.target.private}\n`,
  );
}

if (import.meta.main) main();
