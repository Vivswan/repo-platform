#!/usr/bin/env bun
// The row's key is the plan's (sync/resolve_row.ts: an HMAC of the slug under the fleet token and
// the run id), matched against ONE listing of the owner's writable repositories instead of a
// re-selection: a row never re-runs the plan's probes, and a repository missing from the listing
// is refused. Every form of the name is masked before anything reaches stdout;
// settings-repos.yml reads the result as TARGET from GITHUB_ENV.

import { appendFileSync } from "node:fs";
import { addMask, fail, notice, requireEnv } from "../shared/gha.ts";
import { maskForms } from "../shared/mask.ts";
import { resolveRow, rowKeyOf } from "../sync/resolve_row.ts";
import { discoverOwnerRepos } from "./discovery.ts";
import { supersededBy, supersededNotice } from "./newest_main.ts";

const keyOf = rowKeyOf(requireEnv("PAT"), requireEnv("GITHUB_RUN_ID"));
const rowKey = requireEnv("ROW_KEY");
const owner = requireEnv("OWNER");
const envFile = requireEnv("GITHUB_ENV");
const sha = requireEnv("GITHUB_SHA");

// Newest wins is asked at the write (docs/settings.md): the plan asked too, but a re-run of failed rows reuses the plan's answer,
// and by then a newer commit's run may have applied. No TARGET skips the apply step, so the row stands down green.
let newer: string | null;
try {
  newer = supersededBy(sha);
} catch (lookFailure) {
  fail(lookFailure instanceof Error ? lookFailure.message : String(lookFailure));
}
if (newer !== null) {
  notice(supersededNotice(sha, newer));
  process.exit(0);
}

const rows = discoverOwnerRepos(owner, "resolve_settings_target: user/repos response");
const resolved = resolveRow(rows, rowKey, keyOf);
if ("refusal" in resolved) fail(`${resolved.refusal}; re-run the workflow`);
for (const form of maskForms(resolved.target.repo)) addMask(form);
appendFileSync(envFile, `TARGET=${resolved.target.repo}\n`);
