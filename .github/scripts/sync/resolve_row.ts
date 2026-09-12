#!/usr/bin/env bun
// The row's transport and its resolver. A row rides the public matrix as an index and a key; the
// resolver reads the key back against ONE listing of the owner's writable repositories, masks every
// form of the name before anything else reaches stdout, and hands the name on through GITHUB_ENV
// (TARGET, TARGET_PRIVATE), which the runner never echoes. fleet/resolve_settings_target.ts is the
// settings apply's entry to the same resolver.

import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import { type DiscoveredRepo, discoverOwnerRepos } from "../fleet/discovery.ts";
import { addMask, fail, requireEnv } from "../shared/gha.ts";
import { maskForms } from "../shared/mask.ts";

/** A row's identity as the public matrix carries it: an HMAC of the slug under the fleet token and
 *  the run id. Without the token it names nothing, and the same repository keys differently in
 *  every run, so a private row rides the matrix and the step env unnamed.
 *
 *  The runner drops a job output that carries a masked value, and every masked form is at least
 *  shared/mask.ts's four characters, so the digest rides in three-character groups behind a
 *  separator no slug, URL, or base64 spelling of one contains.
 *    private repository `beef`, raw digest `...becbeef8c...`  -> the whole matrix dropped, every row red */
export function rowKeyOf(pat: string, runId: string): (repo: string) => string {
  return (repo) =>
    createHmac("sha256", pat)
      .update(`${runId}\n${repo}`)
      .digest("hex")
      .replace(/.{3}(?=.)/g, "$&~");
}

/** The matrix's include rows: an index for the job name, a key for the resolver. The `include`
 *  word itself stays in the workflow: seven letters a private name could match. */
export function matrixRows(
  rows: DiscoveredRepo[],
  keyOf: (repo: string) => string,
): { row: number; key: string }[] {
  return rows.map((row, index) => ({ row: index, key: keyOf(row.repo) }));
}

/** The listed repository carrying the plan's key, or a refusal naming no repository. */
export function resolveRow(
  rows: DiscoveredRepo[],
  key: string,
  keyOf: (repo: string) => string,
): { target: DiscoveredRepo } | { refusal: string } {
  const target = rows.find((row) => keyOf(row.repo) === key);
  if (target === undefined) {
    return {
      refusal:
        "the row's key names no repository in the owner's listing: the fleet moved since the plan job ran (a repository revoked or renamed mid-run)",
    };
  }
  return { target };
}

/** The row's step: one listing of the owner's writable repositories, the row matched by key, every
 *  form of the name masked, then `handOn`'s lines appended to GITHUB_ENV. The listing is the check,
 *  not a re-selection: a repository the listing no longer names fails the step naming nothing, and
 *  one still listed is this run's target whatever its registration or the token's grant now says.
 *
 *  Env: ROW_KEY (the plan's key for this row), PAT and GITHUB_RUN_ID (the key's inputs), OWNER and
 *  GH_TOKEN (the listing), GITHUB_ENV. */
export function resolveTarget(script: string, handOn: (target: DiscoveredRepo) => string): void {
  const keyOf = rowKeyOf(requireEnv("PAT"), requireEnv("GITHUB_RUN_ID"));
  const rowKey = requireEnv("ROW_KEY");
  const owner = requireEnv("OWNER");
  const envFile = requireEnv("GITHUB_ENV");
  const rows = discoverOwnerRepos(owner, `${script}: user/repos response`);
  const resolved = resolveRow(rows, rowKey, keyOf);
  if ("refusal" in resolved) fail(`${resolved.refusal}; re-run the workflow`);
  for (const form of maskForms(resolved.target.repo)) addMask(form);
  appendFileSync(envFile, handOn(resolved.target));
}

if (import.meta.main) {
  resolveTarget(
    "resolve_row",
    (target) => `TARGET=${target.repo}\nTARGET_PRIVATE=${target.private}\n`,
  );
}
