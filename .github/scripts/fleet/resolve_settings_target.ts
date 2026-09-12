#!/usr/bin/env bun
// The one step of an apply job that sees its target's name in the clear. The row's key is the
// plan's (sync/resolve_row.ts: an HMAC of the slug under the fleet token and the run id), and this
// step finds the repository it names in one listing of the owner's writable repositories, so a
// row never re-runs the plan's probes and the fleet's size widens the matrix alone. Before
// anything else reaches stdout, every form of the name is registered with the runner's masker;
// the name then leaves this step as TARGET through GITHUB_ENV, the way the sync's resolver hands
// its row's name on.
//
// Env: ROW_KEY (the plan's key for this row), PAT and GITHUB_RUN_ID (the key's inputs), OWNER,
// GITHUB_ENV.

import { appendFileSync } from "node:fs";
import { addMask, fail, requireEnv } from "../shared/gha.ts";
import { maskForms } from "../shared/mask.ts";
import { resolveRow, rowKeyOf } from "../sync/resolve_row.ts";
import { discoverOwnerRepos } from "./discovery.ts";

const keyOf = rowKeyOf(requireEnv("PAT"), requireEnv("GITHUB_RUN_ID"));
const rowKey = requireEnv("ROW_KEY");
const owner = requireEnv("OWNER");
const envFile = requireEnv("GITHUB_ENV");

const rows = discoverOwnerRepos(owner, "resolve_settings_target: user/repos response");
const resolved = resolveRow(rows, rowKey, keyOf);
if ("refusal" in resolved) fail(`${resolved.refusal}; re-run the workflow`);
for (const form of maskForms(resolved.target.repo)) addMask(form);
appendFileSync(envFile, `TARGET=${resolved.target.repo}\n`);
