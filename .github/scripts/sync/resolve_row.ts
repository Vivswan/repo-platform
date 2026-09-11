#!/usr/bin/env bun
// The one step of a sync row that sees the target's name in the clear.
// The row job re-runs discovery and selection (the same scripts the plan
// job ran, their output in $RUNNER_TEMP files) and this step maps the
// row's index to a repository from the selector's rows file. Before
// anything else reaches stdout, every form of the name is registered with
// the runner's masker; the name then leaves this step only through
// GITHUB_ENV (TARGET, TARGET_PRIVATE), which the runner never echoes.
//
// Env: ROW (this row's index), PLANNED (the plan job's row count),
// RUNNER_TEMP (the rows file), GITHUB_ENV.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { addMask, fail, requireEnv } from "../shared/gha.ts";
import { parseJson, parseWith } from "../shared/json.ts";
import { ROWS_FILE } from "./verdict.ts";

/** A selector row: the repository and its visibility. */
const planRowSchema = z.object({ repo: z.string().min(1), private: z.boolean() });
export type PlanRow = z.infer<typeof planRowSchema>;

/** The bare name is masked from four characters: a shorter one appears
 *  inside too many innocent words for a substring masker. */
export const MIN_MASKED_NAME = 4;

/** Every spelling of `slug` a log line could carry, deduplicated. */
export function maskForms(slug: string): string[] {
  const name = slug.split("/").pop() ?? slug;
  const forms = [
    slug,
    `https://github.com/${slug}`,
    `https://github.com/${slug}.git`,
    `git@github.com:${slug}.git`,
  ];
  if (name.length >= MIN_MASKED_NAME) forms.push(name);
  return [...new Set(forms.flatMap((form) => [form, form.toLowerCase()]))];
}

/** The repository row `index` names, or the reason the plan's rows cannot
 *  be trusted (the re-run selection disagrees with the plan's count, or
 *  the index is outside it), naming no repository. */
export function resolveRow(
  rows: PlanRow[],
  index: number,
  planned: number,
): { target: PlanRow } | { refusal: string } {
  if (rows.length !== planned) {
    return {
      refusal: `the selection changed since the plan job ran (${rows.length} rows now, ${planned} planned): the fleet or a repository's registration moved mid-run`,
    };
  }
  const row = rows[index];
  if (!Number.isInteger(index) || row === undefined) {
    return { refusal: `ROW must be an index into the plan's ${rows.length} rows` };
  }
  return { target: row };
}

function main(): void {
  const runnerTemp = requireEnv("RUNNER_TEMP");
  const rows = parseWith(
    z.array(planRowSchema),
    parseJson(readFileSync(join(runnerTemp, ROWS_FILE), "utf-8"), "resolve_row: rows"),
    "resolve_row: rows",
  );
  const resolved = resolveRow(rows, Number(requireEnv("ROW")), Number(requireEnv("PLANNED")));
  if ("refusal" in resolved) fail(`${resolved.refusal}; re-run the workflow`);
  for (const form of maskForms(resolved.target.repo)) addMask(form);
  appendFileSync(
    requireEnv("GITHUB_ENV"),
    `TARGET=${resolved.target.repo}\nTARGET_PRIVATE=${resolved.target.private}\n`,
  );
}

if (import.meta.main) main();
