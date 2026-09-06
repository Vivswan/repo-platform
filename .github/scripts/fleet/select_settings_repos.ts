#!/usr/bin/env bun
// Discovers the settings targets and builds the per-repo apply matrix
// for settings-repos.yml. A target is an enrolled repo (the fleet token
// can push - probed, since user/repos' permissions field reflects the
// USER, not the token) that is adopted - a readable .repo-platform.yml is
// the opt-in to centrally managed settings. The operator repository itself is always
// a target (build_settings_matrix.ts's --self row; its baseline facts
// come from .repo-platform-answers.yml).
//
// One repo's flaky probe must never block the heal for the rest of the
// fleet: every probe is retried, and a repo whose probes still return no
// answer is skipped with a warning - the nightly cron retries it. exit 1
// stays reserved for failures that invalidate the whole selection
// (discovery, or the matrix builder).
//
// This job's log, step summary, and matrix are publicly readable, so
// private repos appear only by their redaction hint (redact.ts): probes
// print the display, captured error text is scrubbed of the slug, and a
// private matrix row carries the hint plus an HMAC tag instead of the
// slug. No ::add-mask:: here - the runner drops a job output holding a
// masked substring, which would kill the matrix.
//
// Env: PAT, GH_TOKEN, GITHUB_RUN_ID, GITHUB_REPOSITORY, OWNER,
// RUNNER_TEMP, GITHUB_OUTPUT; GITHUB_STEP_SUMMARY (optional) receives a
// copy of every warning; GITHUB_EVENT_PATH supplies the dispatch scope
// input (a non-empty ONLY_REPO env overrides it - post-green.yml's called
// run passes its scope that way, and so do the test harness and local
// runs). The scope grammar is the sync's (sync_scope.ts): owner/name slugs
// (a bare name takes the fleet owner), public, private, or "all".

import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { env, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { parseJson } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";
import { declaredModules } from "./build_settings_matrix.ts";
import {
  captureNetwork,
  discoverOwnerRepos,
  notAdoptedNotice,
  pushProbeSkipNotice,
  readDispatchRepo,
  scopeSource,
  scrubSlug,
} from "./discovery.ts";
import { pushProbeStatus } from "./push_probe.ts";
import { type EnrichedRow, enrich, verifyTag } from "./redact.ts";
import { parseScope, scopeRefusal, scopeSelects } from "./sync_scope.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");
const pat = requireEnv("PAT");
const runId = requireEnv("GITHUB_RUN_ID");
const owner = requireEnv("OWNER");
const selfRepo = requireEnv("GITHUB_REPOSITORY");

// A bare name gets the fleet owner prefixed; the read-and-fold rationale
// lives with readDispatchRepo. A list is validated against the discovered
// fleet once the rows are known (below).
const scope = parseScope(readDispatchRepo(owner));
if (scope.kind === "error") {
  console.log(`::error::${scope.message}`);
  process.exit(1);
}

// A drop that leaves a repo without settings management is announced: a
// workflow warning, plus a step-summary bullet (under a heading written
// once) when running in Actions. Routine skips stay at notice level and
// out of the summary. Callers pass already-safe strings: the summary is
// not covered by the runner's masker, so redaction happens before here.
let summaryHeaded = false;
function warn(message: string): void {
  console.log(`::warning::${message}`);
  const summary = env("GITHUB_STEP_SUMMARY");
  if (summary !== "") {
    if (!summaryHeaded) {
      appendFileSync(summary, "### Settings heal warnings\n");
      summaryHeaded = true;
    }
    appendFileSync(summary, `- ${message}\n`);
  }
}

// Each probe answers one question about one repo. Results: "pass" keeps
// the repo, "drop" is a definitive negative (the probe already explained
// it), and any string is the no-answer detail for the retry loop.
type ProbeResult = "pass" | "drop" | { detail: string };

// Enrollment = the token's actual grant (push_probe.ts; 200 only with
// push permission; 401/403/404 = no grant; a transport failure reports 0
// and is retried like any other non-answer).
function probePush(slug: string, display: string): ProbeResult {
  const code = pushProbeStatus(slug, pat);
  if (code === 200) return "pass";
  if (code === 401 || code === 403 || code === 404) {
    notice(pushProbeSkipNotice(display, code));
    return "drop";
  }
  return { detail: `HTTP ${String(code).padStart(3, "0")}` };
}

// The adoption probe: the repo's .repo-platform.yml must exist and carry a
// readable modules list. Only a 404 means "not adopted"; any other API
// failure is a non-answer. An unreadable modules list is a repo defect
// worth a warning - its settings stay unmanaged until fixed.
function probeAdoption(slug: string, display: string): ProbeResult {
  const probe = captureNetwork([
    "gh",
    "api",
    `repos/${slug}/contents/.repo-platform.yml`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (probe.exitCode === 0) {
    if (declaredModules(probe.stdout) !== null) return "pass";
    warn(
      `${display}: its .repo-platform.yml has no readable top-level modules list, so its ` +
        "settings baseline cannot be computed - the repo is skipped and its settings stay " +
        "unmanaged until the file is fixed.",
    );
    return "drop";
  }
  if (/HTTP 404/.test(probe.stderr)) {
    notice(notAdoptedNotice(display, "The settings heal only manages adopted repos."));
    return "drop";
  }
  return { detail: probe.stderr.replace(/\n+$/, "") };
}

// true keeps the repo in the pipeline, false drops it - either a
// definitive negative (already reported by the probe) or still no answer
// after the retries, which warns loudly: a silently dropped repo would
// heal nothing tonight and nobody would know. The no-answer detail is
// scrubbed of the slug and bare name before printing when the two differ
// from the display.
const ATTEMPTS = 3;
// Test knob: the harness sets it to 0 so retry coverage does not sleep.
const RETRY_DELAY_MS = Number(env("PROBE_RETRY_DELAY_MS", "5000"));
async function probe(
  label: string,
  fn: (slug: string, display: string) => ProbeResult,
  slug: string,
  display: string,
): Promise<boolean> {
  let detail = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = fn(slug, display);
    if (result === "pass") return true;
    if (result === "drop") return false;
    detail = scrubSlug(result.detail, slug, display);
    if (attempt < ATTEMPTS) {
      console.log(
        `${display}: ${label} failed (attempt ${attempt}/${ATTEMPTS}: ${detail}); retrying...`,
      );
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
  warn(
    `${display}: the ${label} failed ${ATTEMPTS} times (last error: ${detail}) - not a permission or adoption answer, so the repo is skipped this run; the nightly heal retries it. If this persists, check the repo's availability and the fleet token.`,
  );
  return false;
}

// Discovery pre-filters to owned, user-writable repos; the token's actual
// grant is probed per repo below. Visibility rides along fail-closed:
// anything but private: false counts as private.
const discovered = discoverOwnerRepos(owner, "select_settings_repos: user/repos response");
const rows = enrich(discovered, (slug) => verifyTag(pat, runId, slug));

// The scope's refusals (sync_scope.ts, counts only): every slug must name
// a repo the fleet knows - a discovered row or the operator repo itself -
// and a called scope may not name a private one. A known repo the probes
// then DROP (not enrolled, not adopted) is a routine notice, so a called
// scope may legitimately select nothing. Visibility is discovery's,
// fail-closed; the operator repo is this very repository, disclosed by
// every log line, so it never counts as private here.
const known = new Map(rows.map((row) => [row.repo.toLowerCase(), row.private]));
known.set(selfRepo.toLowerCase(), false);
const isPrivate = (slug: string) => known.get(slug.toLowerCase()) ?? true;
const refusal = scopeRefusal(scope, known, scopeSource("SOURCE_SHA"), owner);
if (refusal !== null) {
  console.log(`::error::${refusal}`);
  process.exit(1);
}

const targets: EnrichedRow[] = [];
for (const row of rows) {
  if (!scopeSelects(scope, row.repo, isPrivate(row.repo))) continue;
  const { repo, display } = row;
  // The operator repo rides in as the matrix builder's --self row (it is
  // not adopted, so the adoption probe would drop it here).
  if (repo.toLowerCase() === selfRepo.toLowerCase()) continue;
  if (!(await probe("push-permission probe", probePush, repo, display))) continue;
  if (!(await probe("settings adoption check", probeAdoption, repo, display))) continue;
  targets.push(row);
}
writeFileSync(join(runnerTemp, "settings_targets.json"), JSON.stringify(targets));

// The matrix joins the probed opt-in list (already scoped above) with the
// operator repo's own row when the scope selects it; a builder failure
// invalidates the whole selection and exits 1. capture() pipes stderr (the
// hang bound needs the pipe); re-emit it whole with writeSync - an async
// stream write racing the process.exit below truncates at the pipe buffer
// (~64 KiB).
const matrix = capture([
  "bun",
  ".github/scripts/fleet/build_settings_matrix.ts",
  "--targets",
  join(runnerTemp, "settings_targets.json"),
  ...(scopeSelects(scope, selfRepo, false) ? ["--self", selfRepo] : []),
]);
writeSync(2, matrix.stderr);
if (matrix.exitCode !== 0) {
  // The builder's ::error:: detail rides its captured stdout (workflow
  // commands parse from stdout); forward it or the failure is silent.
  // Program name only on expiry: the argv tail can carry a private slug.
  if (matrix.timedOut) console.error("bun timed out (proc.ts hang bound)");
  writeSync(1, matrix.stdout);
  process.exit(matrix.exitCode);
}
const targetsJson = matrix.stdout.replace(/\n$/, "");
setOutput("targets", targetsJson);
const parsed = parseJson(targetsJson, "select_settings_repos: settings matrix") as {
  repo: string;
}[];
console.log(
  `settings targets: ${parsed.length === 0 ? "(none)" : parsed.map((t) => t.repo).join(", ")}`,
);
