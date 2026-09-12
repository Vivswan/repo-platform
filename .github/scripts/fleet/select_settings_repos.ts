#!/usr/bin/env bun
// The log and step summary are public, so every discovered private slug is masked before anything
// else prints. One repo's flaky probe never blocks the rest: exit 1 is reserved for failures that
// invalidate the whole selection, and the nightly cron retries a skipped repo. The targets leave
// as the apply matrix's keyed rows (sync/resolve_row.ts): the job output that feeds it is public,
// and a slug there would be dropped by the runner as masked or, unmasked, name a private repository.

import { appendFileSync } from "node:fs";
import { declaredModules } from "../../../actions/plan/registration.ts";
import { REGISTRATION_PATH } from "../../../actions/shared/platform.ts";
import { addMask, env, error, fail, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { maskForms } from "../shared/mask.ts";
import { moduleRoster } from "../sync/modules.ts";
import { planMatrix, rowKeyOf } from "../sync/resolve_row.ts";
import { RENDERED_HEADER } from "../sync/writer/settings_entry.ts";
import {
  captureNetwork,
  type DiscoveredRepo,
  discoverOwnerRepos,
  notAdoptedNotice,
  notRenderedNotice,
  PRIVATE_DISPLAY,
  pushProbeSkipNotice,
  readDispatchRepo,
  scopeSource,
  scrubSlug,
  selectedLine,
} from "./discovery.ts";
import { supersededBy, supersededNotice } from "./newest_main.ts";
import { pushProbeStatus } from "./push_probe.ts";
import {
  modulesAdmit,
  modulesFilterFor,
  modulesLeftOutLine,
  parseScope,
  scopeRefusal,
  scopeSelects,
} from "./sync_scope.ts";

const pat = requireEnv("PAT");
const owner = requireEnv("OWNER");
const runId = requireEnv("GITHUB_RUN_ID");
const sha = requireEnv("GITHUB_SHA");

const scope = parseScope(readDispatchRepo(owner), new Set(moduleRoster()));
if (scope.kind === "error") {
  error(scope.message);
  process.exit(1);
}

function emitPlan(targets: DiscoveredRepo[]): void {
  setOutput("count", String(targets.length));
  setOutput("matrix", JSON.stringify(planMatrix(targets, rowKeyOf(pat, runId))));
}

// Newest wins (docs/settings.md): a run main moved past hands the apply an empty plan and exits green, since the tip's own run
// applies. Asked before the first fleet read, so a superseded run names nothing and spins up no row; the row's resolver asks
// again at the write, because a re-run of failed rows reuses this plan. The catch owns the exit for a failed look.
let newer: string | null;
try {
  newer = supersededBy(sha);
} catch (lookFailure) {
  fail(lookFailure instanceof Error ? lookFailure.message : String(lookFailure));
}
if (newer !== null) {
  notice(supersededNotice(sha, newer));
  emitPlan([]);
  process.exit(0);
}

// The step summary is not covered by the runner's masker, so callers pass already-scrubbed text.
let summaryHeaded = false;
function warn(message: string): void {
  console.log(`::warning::${message}`);
  const summary = env("GITHUB_STEP_SUMMARY");
  if (summary !== "") {
    if (!summaryHeaded) {
      appendFileSync(summary, "### Settings apply warnings\n");
      summaryHeaded = true;
    }
    appendFileSync(summary, `- ${message}\n`);
  }
}

// A drop has already printed its own notice.
type ProbeResult<T> =
  | { kind: "pass"; value: T }
  | { kind: "drop" }
  | { kind: "retry"; detail: string };

// Enrollment = the token's actual grant (push_probe.ts; 200 only with push
// permission; 401/403/404 = no grant; a transport failure reports 0).
function probePush(slug: string, display: string): ProbeResult<true> {
  const code = pushProbeStatus(slug, pat);
  if (code === 200) return { kind: "pass", value: true };
  if (code === 401 || code === 403 || code === 404) {
    notice(pushProbeSkipNotice(display));
    return { kind: "drop" };
  }
  return { kind: "retry", detail: `HTTP ${String(code).padStart(3, "0")}` };
}

/** The content is target-owned text: read for a fact, never printed. */
function readRepoFile(slug: string, path: string) {
  return captureNetwork([
    "gh",
    "api",
    `repos/${slug}/contents/${path}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
}

// Only a 404 means "not adopted"; any other failure is a no-answer, so an outage never reads as an
// opt-out.
function probeAdoption(slug: string, display: string): ProbeResult<{ modules: string[] | null }> {
  const probe = readRepoFile(slug, REGISTRATION_PATH);
  if (probe.exitCode === 0) {
    return { kind: "pass", value: { modules: declaredModules(probe.stdout) } };
  }
  if (/HTTP 404/.test(probe.stderr)) {
    notice(notAdoptedNotice(display, "The settings apply only manages adopted repos."));
    return { kind: "drop" };
  }
  return { kind: "retry", detail: probe.stderr.replace(/\n+$/, "") };
}

// The apply reads each target's own .github/settings.yml, so a hand-written one is as unready as a
// missing one.
function probeRendered(slug: string, display: string): ProbeResult<true> {
  const probe = readRepoFile(slug, ".github/settings.yml");
  if (probe.exitCode === 0) {
    if (probe.stdout.split("\n", 1)[0] === RENDERED_HEADER) return { kind: "pass", value: true };
    notice(notRenderedNotice(display));
    return { kind: "drop" };
  }
  if (/HTTP 404/.test(probe.stderr)) {
    notice(notRenderedNotice(display));
    return { kind: "drop" };
  }
  return { kind: "retry", detail: probe.stderr.replace(/\n+$/, "") };
}

// No answer after the retries warns rather than notices: a silently dropped repo would heal nothing
// tonight.
const ATTEMPTS = 3;
// Test knob: the harness sets it to 0 so retry coverage does not sleep.
const RETRY_DELAY_MS = Number(env("PROBE_RETRY_DELAY_MS", "5000"));
async function probe<T>(
  label: string,
  fn: (slug: string, display: string) => ProbeResult<T>,
  slug: string,
  display: string,
): Promise<T | null> {
  let detail = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = fn(slug, display);
    if (result.kind === "pass") return result.value;
    if (result.kind === "drop") return null;
    detail = scrubSlug(result.detail, slug, display);
    if (attempt < ATTEMPTS) {
      console.log(
        `${display}: ${label} failed (attempt ${attempt}/${ATTEMPTS}: ${detail}); retrying...`,
      );
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
  warn(
    `${display}: the ${label} failed ${ATTEMPTS} times (last error: ${detail}) - no answer, so the repo is skipped this run; the nightly apply retries it. If this persists, check the repo's availability and the fleet token.`,
  );
  return null;
}

const discovered = discoverOwnerRepos(owner, "select_settings_repos: user/repos response");
// Before anything else prints: the masker covers what a scrub might miss.
for (const row of discovered) {
  if (row.private) for (const form of maskForms(row.repo)) addMask(form);
}

// A slug the probes later DROP is a routine notice, so a valid scope may select nothing.
const known = new Map(discovered.map((row) => [row.repo.toLowerCase(), row.private]));
const refusal = scopeRefusal(scope, known, scopeSource("SOURCE_SHA"), owner);
if (refusal !== null) {
  error(refusal);
  process.exit(1);
}

const targets: DiscoveredRepo[] = [];
let leftOut = 0;
for (const row of [...discovered].sort((a, b) => (a.repo < b.repo ? -1 : 1))) {
  const { repo } = row;
  const display = row.private ? PRIVATE_DISPLAY : repo;
  if (!scopeSelects(scope, repo, row.private)) continue;
  if ((await probe("push-permission probe", probePush, repo, display)) === null) continue;
  const adopted = await probe("adoption check", probeAdoption, repo, display);
  if (adopted === null) continue;
  // A repo the filter leaves out is counted, never named: it may be private.
  const filters = modulesFilterFor(scope, repo);
  if (filters !== null) {
    if (adopted.modules === null) {
      warn(
        `${display}: its ${REGISTRATION_PATH} has no readable top-level modules list, so the modules filter cannot judge it - left out of this run; fix the file (the sync would fail on it too), then dispatch the repo by slug or re-run.`,
      );
      continue;
    }
    if (!modulesAdmit(filters, adopted.modules)) {
      leftOut++;
      continue;
    }
  }
  if ((await probe("rendered settings check", probeRendered, repo, display)) === null) continue;
  targets.push(row);
}

const leftOutLine = modulesLeftOutLine(scope, leftOut);
if (leftOutLine !== null) console.log(leftOutLine);
emitPlan(targets);
const line = selectedLine(
  targets,
  "settings targets",
  "no settings targets selected; nothing to apply.",
);
if (targets.length === 0) notice(line);
else console.log(line);
