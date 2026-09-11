#!/usr/bin/env bun
// The one step of a sync row that sees the target's name in the clear.
// The row job re-runs discovery and selection (the same scripts the plan
// job ran, their output in $RUNNER_TEMP files) and this step maps the
// row's index to a repository: a public row names itself, a private row
// is the discovered repository whose resolution tag (redact.ts) matches.
// Before anything else reaches stdout, every form of the name is
// registered with the runner's masker; the name then leaves this step only
// through GITHUB_ENV (TARGET, TARGET_PRIVATE), which the runner never echoes.
//
// Env: ROWS (the selector's rows JSON), ROW (this row's index), PLANNED
// (the plan job's row count), PAT, GITHUB_RUN_ID, RUNNER_TEMP
// (discovered.json), GITHUB_ENV.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseDiscoveredList, verifyTag } from "../fleet/redact.ts";
import { addMask, fail, requireEnv } from "../shared/gha.ts";
import { parseJson, parseWith } from "../shared/json.ts";

/** A selector row: the slug for a public repository, the display hint
 *  plus its resolution tag for a private one. */
const planRowSchema = z.object({
  repo: z.string(),
  private: z.boolean(),
  verify: z.string(),
});
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

/** The repository row `index` names: the row itself for a public row, the
 *  unique discovered repository whose tag matches for a private one. */
export function resolveRow(
  rows: PlanRow[],
  index: number,
  discovered: { repo: string; private: boolean }[],
  tagOf: (slug: string) => string,
): { repo: string; private: boolean } {
  const row = rows[index];
  if (row === undefined) throw new Error(`row ${index} is outside the plan's ${rows.length} rows`);
  if (!row.private) return { repo: row.repo, private: false };
  const matches = discovered
    .filter((entry) => entry.private)
    .map((entry) => entry.repo)
    .filter((slug) => tagOf(slug) === row.verify);
  if (matches.length !== 1) {
    throw new Error(
      `row ${index}'s resolution tag matched ${matches.length} discovered repositories; expected exactly one`,
    );
  }
  return { repo: matches[0], private: true };
}

function main(): void {
  const rows = parseWith(
    z.array(planRowSchema),
    parseJson(requireEnv("ROWS"), "resolve_row: rows"),
    "resolve_row: rows",
  );
  const planned = Number(requireEnv("PLANNED"));
  if (rows.length !== planned) {
    fail(
      `the selection changed since the plan job ran (${rows.length} rows now, ${planned} planned): the fleet or a repository's registration moved mid-run; re-run the workflow`,
    );
  }
  const index = Number(requireEnv("ROW"));
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
    fail(`ROW must be an index into the plan's ${rows.length} rows (got '${requireEnv("ROW")}')`);
  }
  const discovered = parseDiscoveredList(
    parseJson(
      readFileSync(join(requireEnv("RUNNER_TEMP"), "discovered.json"), "utf-8"),
      "resolve_row: discovered list",
    ),
  );
  if (discovered === null) fail("resolve_row: discovered.json is not a list of {repo, private}");
  const pat = requireEnv("PAT");
  const runId = requireEnv("GITHUB_RUN_ID");
  let target: { repo: string; private: boolean };
  try {
    target = resolveRow(rows, index, discovered, (slug) => verifyTag(pat, runId, slug));
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}; re-run the workflow`);
  }
  for (const form of maskForms(target.repo)) addMask(form);
  appendFileSync(
    requireEnv("GITHUB_ENV"),
    `TARGET=${target.repo}\nTARGET_PRIVATE=${target.private}\n`,
  );
}

if (import.meta.main) main();
