#!/usr/bin/env bun
// Selects the push-sync fan-out: every discovered repo the token can
// ACTUALLY push to (probed per repo - the PAT's grant is the only
// membership fact) that has adopted the template. Invoked by sync-repos.yml's
// plan job after discovery wrote $RUNNER_TEMP/discovered.json.
//
// This job's log and matrix are publicly readable, so private repos appear
// only by their redaction hint (redact.ts): a private matrix row carries
// {repo: <hint>, verify} instead of the slug. No ::add-mask:: here: the
// runner silently drops a job output containing a masked substring, which
// would kill the matrix.
//
// Scope (sync_scope.ts owns the grammar): owner/name slugs, public/private,
// or the literal "all", an explicit whole-fleet scope (never ambiguous, since
// real slugs are always owner/name). RECOVER=recopy requires a scope: a
// recovery re-render clobbers local edits in template-managed files and must
// never fan out across the fleet by accident, so an empty repo is rejected.
// Only the input's PRESENCE is judged (its value may be a private slug and
// this log is public); sync-repos.yml fast-fails the same check before
// checkout, and the copy here is the tested backstop. Env: PAT, GH_TOKEN,
// GITHUB_RUN_ID, OWNER, RUNNER_TEMP, GITHUB_OUTPUT, RECOVER, GITHUB_EVENT_PATH.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env, error, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { parseJson } from "../shared/json.ts";
import {
  captureNetwork,
  notAdoptedNotice,
  pushProbeSkipNotice,
  readDispatchRepo,
  scopeSource,
  scrubSlug,
} from "./discovery.ts";
import { pushProbeStatus } from "./push_probe.ts";
import { enrich, parseDiscoveredList, verifyTag } from "./redact.ts";
import { parseScope, scopeRefusal, scopeSelects } from "./sync_scope.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");
const pat = requireEnv("PAT");
const runId = requireEnv("GITHUB_RUN_ID");
const owner = requireEnv("OWNER");

const scopeInput = readDispatchRepo();

// Recovery scope guard (full contract in the header above): recopy needs
// an explicit repo scope, and "all" is the deliberate whole-fleet form.
if (env("RECOVER") === "recopy" && scopeInput === "") {
  error(
    "recover=recopy needs an explicit scope: dispatch it with repo=<owner/name> to recover one repository, or repo=all to fan the recovery out across every managed repo.",
  );
  process.exit(1);
}

const scope = parseScope(scopeInput);
if (scope.kind === "error") {
  error(scope.message);
  process.exit(1);
}

// The whole discovered fleet becomes rows, then the scope applies to them:
// the visibility tokens need every row, and a slug must name a discovered
// repo or the run fails (below). Visibility is discovery's, fail-closed
// (parseDiscoveredList rejects an entry without an explicit private flag).
// parseJson, not a raw JSON.parse: discovered.json carries real slugs, and
// a SyntaxError echoing them would leak into this public log.
const discovered = parseDiscoveredList(
  parseJson(
    readFileSync(join(runnerTemp, "discovered.json"), "utf-8"),
    "select_sync_repos: discovered list",
  ),
);
if (discovered === null) {
  error("select_sync_repos: the discovered list must be a JSON array of {repo, private} objects");
  process.exit(1);
}
const rows = enrich(discovered, (slug) => verifyTag(pat, runId, slug));
const known = new Map(rows.map((row) => [row.repo.toLowerCase(), row.private]));
const refusal = scopeRefusal(scope, known, scopeSource("TARGET_SHA"), owner);
if (refusal !== null) {
  error(refusal);
  process.exit(1);
}

const repos: Record<string, unknown>[] = [];
for (const row of rows) {
  const { repo: slug, display } = row;
  if (!scopeSelects(scope, slug, row.private)) continue;
  const probeCode = pushProbeStatus(slug, pat);
  if (probeCode === 401 || probeCode === 403 || probeCode === 404) {
    notice(pushProbeSkipNotice(display));
    continue;
  }
  if (probeCode !== 200) {
    error(
      `push-permission probe for ${display} failed with HTTP ${String(probeCode).padStart(3, "0")}; not a permission answer, refusing to guess.`,
    );
    process.exit(1);
  }
  // Only a 404 means "not adopted"; any other API failure (auth, rate
  // limit, outage) fails the plan instead of silently skipping repos.
  const adoption = captureNetwork([
    "gh",
    "api",
    `repos/${slug}/contents/.repo-platform.yml`,
    "--silent",
  ]);
  if (adoption.exitCode === 0) {
    // The display IS the slug for public rows (enrichedRowSchema holds
    // that invariant), so every matrix row can emit it as its repo.
    repos.push({ repo: row.display, private: row.private, verify: row.verify });
  } else {
    const probe = adoption.stdout + adoption.stderr;
    if (/HTTP 404/.test(probe)) {
      notice(notAdoptedNotice(display));
    } else {
      error(`adoption check failed for ${display}: ${scrubSlug(probe, slug, display)}`);
      process.exit(1);
    }
  }
}

setOutput("repos", JSON.stringify(repos));
if (repos.length === 0) {
  notice("no adopted repos selected; nothing to sync.");
} else {
  console.log(`syncing: ${repos.map((row) => row.repo).join(", ")}`);
}
