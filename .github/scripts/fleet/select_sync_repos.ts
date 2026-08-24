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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, error, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";
import { pushProbeStatus } from "./push_probe.ts";
import { parseEnriched } from "./redact.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");
const pat = requireEnv("PAT");

// The typed dispatch input may be a private slug, so it must not ride in
// as step env: the runner prints step env values into the public log
// group. The event payload on the runner's disk is not logged.
let onlyRepo = env("ONLY_REPO");
if (onlyRepo === "" && env("GITHUB_EVENT_PATH") !== "") {
  const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf-8")) as {
    inputs?: { repo?: string };
  };
  onlyRepo = event.inputs?.repo ?? "";
}
// Same normalization as the settings selector: GitHub identity is
// case-insensitive, so the dispatch input folds before any comparison.
onlyRepo = onlyRepo.trim().toLowerCase();

// Recovery scope guard (full contract in the header above): recopy needs
// an explicit repo scope, and "all" is the deliberate whole-fleet form.
if (env("RECOVER") === "recopy" && onlyRepo === "") {
  error(
    "recover=recopy needs an explicit scope: dispatch it with repo=<owner/name> to recover one repository, or repo=all to fan the recovery out across every managed repo.",
  );
  process.exit(1);
}

if (onlyRepo === "all") onlyRepo = "";

function runStage(command: string[], outFile: string): void {
  const proc = Bun.spawnSync(command, { stdout: "pipe", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    // The stage's ::error:: detail rides its captured stdout (workflow
    // commands parse from stdout); forward it or the failure is silent.
    process.stdout.write(proc.stdout.toString());
    process.exit(proc.exitCode ?? 1);
  }
  writeFileSync(outFile, proc.stdout);
}

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

const enriched = parseEnriched(
  JSON.parse(readFileSync(join(runnerTemp, "enriched.json"), "utf-8")),
  "select_sync_repos: enriched rows",
);

const repos: Record<string, unknown>[] = [];
for (const row of enriched.rows) {
  const { repo: slug, display } = row;
  const probeCode = pushProbeStatus(slug, pat);
  if (probeCode === 401 || probeCode === 403 || probeCode === 404) {
    notice(
      `${display}: skipped - the fleet token has no write access (push probe HTTP ${probeCode}). Grant the REPO_PLATFORM_TOKEN access to this repository to enroll it, or add it to repos.yml's exclude list to silence this.`,
    );
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
  const adoption = capture(["gh", "api", `repos/${slug}/contents/.repo-platform.yml`, "--silent"]);
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
    let probe = adoption.stdout + adoption.stderr;
    if (/HTTP 404/.test(probe)) {
      notice(
        `${display}: skipped - no .repo-platform.yml on its default branch, so it has not adopted the template. Generate it with copier (see the repo-platform README) to opt in, or add it to repos.yml's exclude list to silence this.`,
      );
    } else {
      if (row.redact_name) {
        probe = probe.replaceAll(slug, display);
        probe = probe.replaceAll(slug.split("/").pop() ?? slug, display);
      }
      error(`adoption check failed for ${display}: ${probe}`);
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
