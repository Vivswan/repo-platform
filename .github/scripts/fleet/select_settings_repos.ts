#!/usr/bin/env bun
// Selects the targets settings-repos.yml hands to github-settings-as-code
// in repos mode: every discovered repo the fleet token can push to (probed
// per repo - the PAT's grant is the only membership fact) that has adopted
// the platform (a readable .repo-platform.yml) and whose .github/settings.yml
// is the sync's rendered document (the generator header on its first line;
// a hand-written file applied alone would delete every fleet label). The
// operator repository is selected like any other.
//
// One repo's flaky probe never blocks the rest: every probe is retried,
// and a repo whose probes still return no answer is skipped with a warning
// (the nightly cron retries it); exit 1 is reserved for failures that
// invalidate the whole selection. The log and the step summary are public:
// every discovered private slug is masked before anything else prints, and
// a private repository is named only as such.
//
// Env: PAT, GH_TOKEN, OWNER, GITHUB_OUTPUT; GITHUB_STEP_SUMMARY (optional)
// receives every warning; GITHUB_EVENT_PATH supplies the dispatch scope
// input (a non-empty ONLY_REPO env overrides it: post-green.yml's called
// run, the harness, local runs), SOURCE_SHA the judged commit a refused
// called scope names. The scope grammar is the sync's (sync_scope.ts).

import { appendFileSync } from "node:fs";
import { declaredModules } from "../../../actions/plan/registration.ts";
import { addMask, env, error, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { maskForms } from "../shared/mask.ts";
import { moduleRoster } from "../sync/modules.ts";
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

// A bare name gets the fleet owner prefixed (readDispatchRepo). A list is
// validated against the discovered fleet once the rows are known (below).
const scope = parseScope(readDispatchRepo(owner), new Set(moduleRoster()));
if (scope.kind === "error") {
  error(scope.message);
  process.exit(1);
}

// A drop that leaves a repo without settings management is announced: a
// workflow warning, plus a step-summary bullet under a heading written
// once. Routine skips stay at notice level and out of the summary. The
// summary is not covered by the runner's masker, so callers pass
// already-scrubbed text.
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

// Each probe answers one question about one repo: a pass carries what it
// learned, a drop is a definitive negative (already explained), and a
// retry carries the no-answer detail for the retry loop.
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

/** A repository file read raw off its default branch; the content is read
 *  for a fact and never printed (it is target-owned text). */
function readRepoFile(slug: string, path: string) {
  return captureNetwork([
    "gh",
    "api",
    `repos/${slug}/contents/${path}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
}

// The adoption probe: a readable .repo-platform.yml is the opt-in; only a
// 404 means "not adopted". The declared list rides along for the scope's
// modules: filters (null when unreadable; the filter judge reports that).
function probeAdoption(slug: string, display: string): ProbeResult<{ modules: string[] | null }> {
  const probe = readRepoFile(slug, ".repo-platform.yml");
  if (probe.exitCode === 0) {
    return { kind: "pass", value: { modules: declaredModules(probe.stdout) } };
  }
  if (/HTTP 404/.test(probe.stderr)) {
    notice(notAdoptedNotice(display, "The settings apply only manages adopted repos."));
    return { kind: "drop" };
  }
  return { kind: "retry", detail: probe.stderr.replace(/\n+$/, "") };
}

// The rendered probe: the apply reads each target's own .github/settings.yml,
// so it must be the sync's document. An absent file and a hand-written one
// are the same skip: the sync PR carrying the render has not merged.
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

// The pass value keeps the repo in the pipeline, null drops it - a definitive
// negative (already reported) or no answer after the retries, which warns
// loudly: a silently dropped repo would heal nothing tonight. The no-answer
// detail is scrubbed of the slug before printing.
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

// Discovery pre-filters to owned, user-writable repos; the token's actual
// grant is probed per repo below. Visibility rides along fail-closed.
const discovered = discoverOwnerRepos(owner, "select_settings_repos: user/repos response");
// Before anything else prints: the masker covers what a scrub might miss,
// and the apply step echoes the repos output into the log.
for (const row of discovered) {
  if (row.private) for (const form of maskForms(row.repo)) addMask(form);
}

// The scope's refusals (sync_scope.ts, counts only): every slug must name
// a discovered repo, and a called scope may not name a private one. A known
// repo the probes then DROP is a routine notice, so a scope may select nothing.
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
  // A filter judges the declared list; a list it cannot read is reported
  // and left out, a repo it leaves out is counted, never named.
  const filters = modulesFilterFor(scope, repo);
  if (filters !== null) {
    if (adopted.modules === null) {
      warn(
        `${display}: its .repo-platform.yml has no readable top-level modules list, so the modules filter cannot judge it - left out of this run; fix the file (the sync would fail on it too), then dispatch the repo by slug or re-run.`,
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
setOutput("count", String(targets.length));
const line = selectedLine(
  targets,
  "settings targets",
  "no settings targets selected; nothing to apply.",
);
if (targets.length === 0) {
  notice(line);
} else {
  setOutput("repos", targets.map((target) => target.repo).join("\n"));
  console.log(line);
}
