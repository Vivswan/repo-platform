#!/usr/bin/env bun
// Selects the push-sync fan-out: applies repos.yml to the discovered
// fleet, probes the token's ACTUAL write grant per repo, and checks
// adoption. Invoked by sync-repos.yml's plan job after the discovery step
// wrote $RUNNER_TEMP/discovered.json ({repo, private} objects).
//
// This job's log and the matrix it emits are publicly readable, so private
// repos appear only by their redaction display (a hint, or the committed
// name when it is self-disclosed - see redact.ts): notices print the
// display, captured API error text is scrubbed of the slug, and a
// redacted matrix row carries {repo: <hint>, verify} instead of the slug.
// No ::add-mask:: here: the runner silently drops a job output containing
// a masked substring, which would kill the matrix.
//
// Env: PAT, GH_TOKEN, GITHUB_RUN_ID, RUNNER_TEMP, GITHUB_OUTPUT, RECOVER;
// GITHUB_EVENT_PATH supplies the repo dispatch input (a non-empty
// ONLY_REPO env overrides it - the test harness and local runs use that).
//
// Recovery scope contract: the repo input scopes the run - an owner/name
// slug selects one repo, the literal "all" is an explicit whole-fleet
// scope (same selection as an empty repo, and never ambiguous: real slugs
// are always owner/name). RECOVER=recopy requires one of the two, because
// a recovery re-render clobbers local edits in template-managed files and
// must never fan out across the fleet by accident: an empty repo is
// rejected, so a fat-fingered recover input on a plain dispatch cannot
// flip every managed repo into manual-review re-render PRs. Only the repo
// input's PRESENCE is judged - its value may be a private slug and this
// log is publicly readable. sync-repos.yml fast-fails the same check
// before checkout; the copy here is the tested backstop.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env, error, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { parseJson } from "../shared/json.ts";
import {
  captureNetwork,
  notAdoptedNotice,
  pushProbeSkipNotice,
  readDispatchRepo,
  runStage,
  scrubSlug,
} from "./discovery.ts";
import { pushProbeStatus } from "./push_probe.ts";
import { parseEnriched } from "./redact.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");
const pat = requireEnv("PAT");

let onlyRepo = readDispatchRepo();

// Recovery scope guard (full contract in the header above): recopy needs
// an explicit repo scope, and "all" is the deliberate whole-fleet form.
if (env("RECOVER") === "recopy" && onlyRepo === "") {
  error(
    "recover=recopy needs an explicit scope: dispatch it with repo=<owner/name> to recover one repository, or repo=all to fan the recovery out across every managed repo.",
  );
  process.exit(1);
}

if (onlyRepo === "all") onlyRepo = "";

runStage(
  [
    "bun",
    ".github/scripts/fleet/repos_registry.ts",
    "select",
    ...(onlyRepo === "" ? [] : ["--repo", onlyRepo]),
    "--discovered",
    join(runnerTemp, "discovered.json"),
  ],
  join(runnerTemp, "selection.json"),
);
runStage(
  [
    "bun",
    ".github/scripts/fleet/redact.ts",
    "enrich",
    "--selection",
    join(runnerTemp, "selection.json"),
    "--discovered",
    join(runnerTemp, "discovered.json"),
  ],
  join(runnerTemp, "enriched.json"),
);

// parseJson, not a raw JSON.parse: enriched.json carries real slugs, and
// a SyntaxError echoing them would leak into this public log.
const enriched = parseEnriched(
  parseJson(
    readFileSync(join(runnerTemp, "enriched.json"), "utf-8"),
    "select_sync_repos: enriched rows",
  ),
  "select_sync_repos: enriched rows",
);

const repos: Record<string, unknown>[] = [];
for (const row of enriched.rows) {
  const { repo: slug, display } = row;
  const probeCode = pushProbeStatus(slug, pat);
  if (probeCode === 401 || probeCode === 403 || probeCode === 404) {
    notice(pushProbeSkipNotice(display, probeCode));
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
    // The display IS the slug for unredacted rows (parseEnriched holds
    // that invariant), so every matrix row can emit it as its repo.
    repos.push({
      repo: row.display,
      channel: row.channel,
      redact_name: row.redact_name,
      hide_details: row.hide_details,
      verify: row.verify,
    });
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
