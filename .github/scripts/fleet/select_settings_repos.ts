#!/usr/bin/env bun
// The log and step summary are public, so every discovered private slug is masked before anything
// else prints. One repo's flaky probe never blocks the rest: exit 1 is reserved for failures that
// invalidate the whole selection, and the nightly cron retries a skipped repo. The targets leave
// as the apply matrix's keyed rows (sync/resolve_row.ts): the job output that feeds it is public,
// and a slug there would be dropped by the runner as masked or, unmasked, name a private repository.

import { error, notice, setOutput, setSecret, summary, warning } from "@actions/core";
import { declaredModules } from "../../../actions/plan/registration.ts";
import { REGISTRATION_PATH, SETTINGS_PATH } from "../../../actions/shared/platform.ts";
import { env, requireEnv } from "../shared/gha.ts";
import { GitHubClient } from "../shared/github.ts";
import { maskForms } from "../shared/mask.ts";
import { matrixRows, rowKeyOf } from "../sync/resolve_row.ts";
import { RENDERED_HEADER } from "../sync/writer/settings_entry.ts";
import {
  type DiscoveredRepo,
  discoverOwnerRepos,
  notAdoptedNotice,
  notRenderedNotice,
  PRIVATE_DISPLAY,
  pushProbeSkipNotice,
  readDispatchRepo,
  selectedLine,
} from "./discovery.ts";
import { moduleRoster } from "./modules.ts";
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
const github = new GitHubClient();

const scope = parseScope(readDispatchRepo(), new Set(moduleRoster()));
if (scope.kind === "error") {
  error(scope.message);
  process.exit(1);
}

function emitPlan(targets: DiscoveredRepo[]): void {
  setOutput("count", String(targets.length));
  setOutput("matrix", JSON.stringify(matrixRows(targets, rowKeyOf(pat, runId))));
}

// The step summary is not covered by the runner's masker, so callers pass already-scrubbed text.
let summaryHeaded = false;
async function warn(message: string): Promise<void> {
  warning(message);
  if (!summaryHeaded) summary.addRaw("### Settings apply warnings", true);
  summaryHeaded = true;
  await summary.addRaw(`- ${message}`, true).write();
}

// A drop is a notice already printed, or a hand-written settings.yml counted and refused after the probes.
type ProbeResult<T> =
  | { kind: "pass"; value: T }
  | { kind: "drop" }
  | { kind: "unanswered"; detail: string };

// The push advertisement is git's, not the REST API, so its retries are this loop's; a REST read carries the client's.
const PUSH_ATTEMPTS = 3;

// Test knob: the harness sets it to 0 so retry coverage does not sleep.
const RETRY_DELAY_MS = Number(env("PROBE_RETRY_DELAY_MS", "5000"));

// Enrollment = the token's actual grant (push_probe.ts; 200 only with push
// permission; 401/403/404 = no grant; a transport failure reports 0).
async function probePush(slug: string, display: string): Promise<ProbeResult<true>> {
  let detail = "";
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    const code = await pushProbeStatus(slug, pat);
    if (code === 200) return { kind: "pass", value: true };
    if (code === 401 || code === 403 || code === 404) {
      notice(pushProbeSkipNotice(display));
      return { kind: "drop" };
    }
    detail = `HTTP ${String(code).padStart(3, "0")}`;
    if (attempt < PUSH_ATTEMPTS) {
      console.log(
        `${display}: push-permission probe failed (attempt ${attempt}/${PUSH_ATTEMPTS}: ${detail}); retrying...`,
      );
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
  return { kind: "unanswered", detail };
}

// Only a 404 means "not adopted"; any other failure is a no-answer, so an outage never reads as an
// opt-out. The content is target-owned text: read for a fact, never printed.
async function probeAdoption(
  slug: string,
  display: string,
): Promise<ProbeResult<{ modules: string[] | null }>> {
  const file = await github.text(`repos/${slug}/contents/${REGISTRATION_PATH}`);
  if (file.kind === "ok") return { kind: "pass", value: { modules: declaredModules(file.value) } };
  if (file.kind === "failed") return { kind: "unanswered", detail: file.reason };
  notice(notAdoptedNotice(display, "The settings apply only manages adopted repos."));
  return { kind: "drop" };
}

// The apply reads each target's own rendered settings document. A hand-written one applied alone would delete every fleet
// label it does not list, so it fails the plan (counted below: the log is public and the target may be private); a
// missing one is a repository before its first sync PR, skipped with a notice.
let handWritten = 0;
async function probeRendered(slug: string, display: string): Promise<ProbeResult<true>> {
  const file = await github.text(`repos/${slug}/contents/${SETTINGS_PATH}`);
  if (file.kind === "failed") return { kind: "unanswered", detail: file.reason };
  if (file.kind === "not-found") {
    notice(notRenderedNotice(display));
    return { kind: "drop" };
  }
  if (file.value.split("\n", 1)[0] === RENDERED_HEADER) return { kind: "pass", value: true };
  handWritten++;
  return { kind: "drop" };
}

// No answer warns rather than notices: a silently dropped repo would heal nothing tonight.
async function probe<T>(
  label: string,
  fn: (slug: string, display: string) => Promise<ProbeResult<T>>,
  slug: string,
  display: string,
): Promise<T | null> {
  const result = await fn(slug, display);
  if (result.kind === "pass") return result.value;
  if (result.kind === "drop") return null;
  await warn(
    `${display}: the ${label} got no answer after its retries (last error: ${result.detail}), so the repo is skipped this run; the nightly apply retries it. If this persists, check the repo's availability and the fleet token.`,
  );
  return null;
}

const discovered = discoverOwnerRepos(owner, "select_settings_repos: user/repos response");
// Before anything else prints: the masker covers what a scrub might miss.
for (const row of discovered) {
  if (row.private) {
    for (const form of maskForms(row.repo)) setSecret(form);
  }
}

// A slug the probes later DROP is a notice or a counted refusal after the probes, so a valid scope may select nothing.

const known = new Set(discovered.map((row) => row.repo.toLowerCase()));
const refusal = scopeRefusal(scope, known, owner);
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
      await warn(
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

if (handWritten > 0) {
  error(
    `${handWritten} selected ${handWritten === 1 ? "target carries" : "targets carry"} a hand-written ` +
      `${SETTINGS_PATH} (names withheld - a target may be private): the apply reads the rendered ` +
      "file alone, so merge the sync PR that renders it, then re-run",
  );
  process.exit(1);
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
