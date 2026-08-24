#!/usr/bin/env bun
// Discovers the settings targets and builds the per-repo apply matrix
// for settings-repos.yml. In-repo targets are enrolled repos (the fleet
// token can push - probed, since user/repos' permissions field reflects
// the USER, not the token), adopted (.repo-platform.yml on the default
// branch), and carrying their own .github/settings.yml - no module
// required, the file is the signal. A central settings/repos/<name>.yml
// wins and drops the repo from the remote list; the matrix carries both
// homes, one entry per repo (build_settings_matrix.ts).
//
// One repo's flaky probe must never block the heal for the rest of the
// fleet: every probe is retried, and a repo whose probes still return no
// answer is skipped with a warning - the nightly cron retries it. exit 1
// stays reserved for failures that invalidate the whole selection
// (unreadable registry, discovery, or exclusion list).
//
// This job's log, step summary, and matrix are publicly readable, so
// private repos appear only by their redaction display (redact.ts):
// probes print the display, captured error text is scrubbed of the slug,
// and a redacted matrix row carries the hint plus an HMAC tag instead of
// the slug. No ::add-mask:: here - the runner drops a job output holding
// a masked substring, which would kill the matrix. Central-file repos and
// repos.yml-excluded repos keep their committed (self-disclosed) names.
//
// Env: PAT, GH_TOKEN, GITHUB_RUN_ID, OWNER, RUNNER_TEMP, GITHUB_OUTPUT;
// GITHUB_STEP_SUMMARY (optional) receives a copy of every warning;
// GITHUB_EVENT_PATH supplies the single-repo dispatch input (a non-empty
// ONLY_REPO env overrides it - the test harness and local runs use that).

import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { parseJson } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";
import {
  discoverOwnerRepos,
  notAdoptedNotice,
  pushProbeSkipNotice,
  readDispatchRepo,
  runStage,
  scrubSlug,
} from "./discovery.ts";
import { pushProbeStatus } from "./push_probe.ts";
import { type EnrichedRow, parseEnriched } from "./redact.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");
const pat = requireEnv("PAT");
const owner = requireEnv("OWNER");

// A bare name gets the fleet owner prefixed; the read-and-fold rationale
// lives with readDispatchRepo.
const onlyRepo = readDispatchRepo(owner);

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

// Only a 404 means "not adopted"; any other API failure is a non-answer.
function probeAdoption(slug: string, display: string): ProbeResult {
  const probe = capture(["gh", "api", `repos/${slug}/contents/.repo-platform.yml`, "--silent"]);
  if (probe.exitCode === 0) return "pass";
  if (/HTTP 404/.test(probe.stderr)) {
    notice(
      notAdoptedNotice(
        display,
        "If it carries .github/settings.yml, the central nightly heal no longer applies it.",
      ),
    );
    return "drop";
  }
  return { detail: probe.stderr.replace(/\n+$/, "") };
}

// Same 404-vs-failure split for the settings file itself. centralRef
// names the central file the warning may reference - the literal
// placeholder form for a redacted repo, whose bare name must not appear.
function probeSettings(slug: string, display: string, centralRef: string): ProbeResult {
  const probe = capture([
    "gh",
    "api",
    `repos/${slug}/contents/.github/settings.yml`,
    "--jq",
    ".sha",
  ]);
  if (probe.exitCode === 0) return "pass";
  if (/HTTP 404/.test(probe.stderr)) {
    // The central file was already ruled out above, so at this point
    // nothing manages the repo's settings.
    warn(
      `${display} is enrolled and adopted but has no settings home: no ${centralRef} here and no .github/settings.yml in the repo. Its settings are unmanaged - nothing installs or heals the main ruleset (so all-green may not be a required check) and labels are never reconciled. Pick a home per docs/settings.md.`,
    );
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
  fn: (slug: string, display: string, centralRef: string) => ProbeResult,
  slug: string,
  display: string,
  centralRef: string,
): Promise<boolean> {
  let detail = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = fn(slug, display, centralRef);
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
writeFileSync(join(runnerTemp, "discovered.json"), JSON.stringify(discovered));

runStage(
  [
    "bun",
    ".github/scripts/fleet/repos_registry.ts",
    "select",
    "--discovered",
    join(runnerTemp, "discovered.json"),
  ],
  join(runnerTemp, "selected.json"),
);
runStage(
  [
    "bun",
    ".github/scripts/fleet/redact.ts",
    "enrich",
    "--selection",
    join(runnerTemp, "selected.json"),
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
    "select_settings_repos: enriched rows",
  ),
  "select_settings_repos: enriched rows",
);

// Central filenames matched case-insensitively, like GitHub slugs (the
// checkout's filesystem may or may not fold case itself).
const centralNames = new Set(readdirSync("settings/repos").map((entry) => entry.toLowerCase()));
const inRepoTargets: EnrichedRow[] = [];
for (const row of enriched.rows) {
  if (onlyRepo !== "" && row.repo.toLowerCase() !== onlyRepo) continue;
  const { repo, display } = row;
  const name = repo.split("/").pop() ?? repo;
  const centralRef = row.redact_name ? "settings/repos/<name>.yml" : `settings/repos/${name}.yml`;
  if (centralNames.has(`${name.toLowerCase()}.yml`)) continue;
  if (!(await probe("push-permission probe", probePush, repo, display, centralRef))) continue;
  if (!(await probe("adoption check", probeAdoption, repo, display, centralRef))) continue;
  if (!(await probe("settings.yml check", probeSettings, repo, display, centralRef))) continue;
  inRepoTargets.push(row);
}
writeFileSync(join(runnerTemp, "in_repo_targets.json"), JSON.stringify(inRepoTargets));

// repos.yml's exclude: pauses the sync AND this heal - the registry drops
// excluded repos before the loop above ever sees them. When such a repo
// still carries an in-repo settings.yml (and no central file has taken
// over), say that the heal stopped instead of going quiet. Materialized
// first so a registry failure fails the run instead of silently
// skipping every exclusion warning. Excluded slugs are committed in
// repos.yml - self-disclosed, so they print plainly.
runStage(
  ["bun", ".github/scripts/fleet/repos_registry.ts", "excluded"],
  join(runnerTemp, "excluded.json"),
);
const excluded = parseJson(
  readFileSync(join(runnerTemp, "excluded.json"), "utf-8"),
  "select_settings_repos: excluded list",
) as string[];
// A single-repo dispatch is a scoped heal; the fleet-wide exclusion
// reminders belong to the full runs.
const sweepable = onlyRepo === "" ? excluded : [];
for (const repo of sweepable) {
  const name = repo.split("/").pop() ?? repo;
  // Central-file existence folds case via centralNames, like every other
  // slug comparison: the exclusion's casing in repos.yml need not match
  // the settings file's.
  if (centralNames.has(`${name.toLowerCase()}.yml`)) continue;
  const probeResult = capture([
    "gh",
    "api",
    `repos/${repo}/contents/.github/settings.yml`,
    "--silent",
  ]);
  if (probeResult.exitCode === 0) {
    warn(
      `${repo} is excluded in repos.yml but still carries .github/settings.yml - the exclusion also pauses the central nightly heal for that file, so its settings can drift. If the pause is deliberate, this is the reminder that healing is off; otherwise remove the exclusion, or move the settings to settings/repos/${name}.yml here (central files are applied regardless of exclude).`,
    );
  } else if (!/HTTP 404/.test(probeResult.stderr)) {
    // A 404 also covers repos the token cannot read; those skip
    // silently. Anything else: this check is purely informational, so
    // report it without killing the apply for the selected repos. The
    // NAME is self-disclosed (committed in repos.yml), but an excluded
    // repo's error detail may not be - unless discovery proves the repo
    // public, only the HTTP code prints.
    let detail = probeResult.stderr.replace(/\n+$/, "");
    const isPublic = discovered.some(
      (entry) => entry.repo.toLowerCase() === repo.toLowerCase() && entry.private === false,
    );
    if (!isPublic) {
      const code = detail.match(/HTTP [0-9]+/)?.[0];
      detail = `${code ?? "no status"} (detail hidden: private repository)`;
    }
    console.log(
      `::warning::settings.yml check for excluded repo ${repo} failed: ${detail} - cannot tell whether its pause left an in-repo settings file behind; continuing.`,
    );
  }
}

// The matrix joins the probed in-repo list with the central files; a
// builder failure (unreadable dir, a central file the per-repo scoping
// cannot represent) invalidates the whole selection and exits 1.
const matrix = Bun.spawnSync(
  [
    "bun",
    ".github/scripts/fleet/build_settings_matrix.ts",
    "--owner",
    owner,
    "--in-repo",
    join(runnerTemp, "in_repo_targets.json"),
    ...(onlyRepo === "" ? [] : ["--only", onlyRepo]),
  ],
  { stdout: "pipe", stderr: "inherit" },
);
if (matrix.exitCode !== 0) {
  // The builder's ::error:: detail rides its captured stdout (workflow
  // commands parse from stdout); forward it or the failure is silent.
  process.stdout.write(matrix.stdout.toString());
  process.exit(matrix.exitCode ?? 1);
}
const targets = matrix.stdout.toString().replace(/\n$/, "");
setOutput("targets", targets);
const parsed = parseJson(targets, "select_settings_repos: settings matrix") as {
  repo: string;
  home: string;
}[];
if (onlyRepo !== "" && parsed.length === 0) {
  // The input is echoed nowhere: the dispatcher typed it, and it may be
  // a private slug this public log must not print.
  console.log(
    "::error::the repo input matches no settings target (matching ignores case): it must be an enrolled repo carrying .github/settings.yml or have a central settings/repos/<name>.yml file, and a repos.yml exclude pauses this heal for it",
  );
  process.exit(1);
}
console.log(
  `settings targets: ${parsed.length === 0 ? "(none)" : parsed.map((t) => `${t.repo} [${t.home}]`).join(", ")}`,
);
