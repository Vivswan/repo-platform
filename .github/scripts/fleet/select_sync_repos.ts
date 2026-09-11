#!/usr/bin/env bun
// Selects the push-sync fan-out: every discovered repo the token can
// ACTUALLY push to (probed per repo - the PAT's grant is the only
// membership fact) that has adopted the platform (a readable
// .repo-platform.yml). Invoked by sync-repos.yml's plan job after
// discovery wrote $RUNNER_TEMP/discovered.json, and again by every row job
// (its output to a file) so row indexes mean the plan's repositories.
//
// The rows go to $RUNNER_TEMP/rows.json with their real slugs; the job
// output carries the count alone. This log is publicly readable, so a
// private repository is never named here: its skips are counted, a public
// one's are noticed by slug. The operator repository is never a row (its
// files are the sources).
//
// Scope (sync_scope.ts owns the grammar): owner/name slugs, public/private,
// modules:<a>+<b> filters (judged over each adopted repo's declared list
// below), or the literal "all", an explicit whole-fleet scope (never
// ambiguous, since real slugs are always owner/name).
// Env: PAT, GH_TOKEN, OWNER, GITHUB_REPOSITORY, RUNNER_TEMP, GITHUB_OUTPUT,
// GITHUB_EVENT_PATH; ONLY_REPO and TARGET_SHA (the workflow_call scope).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { declaredModules } from "../../../actions/plan/registration.ts";
import { error, notice, requireEnv, setOutput, warning } from "../shared/gha.ts";
import { parseJson } from "../shared/json.ts";
import { moduleRoster } from "../sync/modules.ts";
import { ROWS_FILE } from "../sync/verdict.ts";
import {
  captureNetwork,
  notAdoptedNotice,
  PRIVATE_DISPLAY,
  parseDiscovered,
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

const runnerTemp = requireEnv("RUNNER_TEMP");
const pat = requireEnv("PAT");
const owner = requireEnv("OWNER");
const selfRepo = requireEnv("GITHUB_REPOSITORY");

const scope = parseScope(readDispatchRepo(), new Set(moduleRoster()));
if (scope.kind === "error") {
  error(scope.message);
  process.exit(1);
}

// The whole discovered fleet becomes rows, then the scope applies to them:
// the visibility tokens need every row, and a slug must name a discovered
// repo or the run fails (below). Visibility is discovery's, fail-closed
// (parseDiscovered rejects an entry without an explicit private flag).
// parseJson, not a raw JSON.parse: discovered.json carries real slugs, and
// a SyntaxError echoing them would leak into this public log.
const discovered = parseDiscovered(
  parseJson(
    readFileSync(join(runnerTemp, "discovered.json"), "utf-8"),
    "select_sync_repos: discovered list",
  ),
);
if (discovered === null) {
  error("select_sync_repos: the discovered list must be a JSON array of {repo, private} objects");
  process.exit(1);
}
const known = new Map(discovered.map((row) => [row.repo.toLowerCase(), row.private]));
const refusal = scopeRefusal(scope, known, scopeSource("TARGET_SHA"), owner);
if (refusal !== null) {
  error(refusal);
  process.exit(1);
}

const rows: { repo: string; private: boolean }[] = [];
let leftOut = 0;
for (const entry of [...discovered].sort((a, b) => (a.repo < b.repo ? -1 : 1))) {
  const slug = entry.repo;
  const display = entry.private ? PRIVATE_DISPLAY : slug;
  if (slug.toLowerCase() === selfRepo.toLowerCase()) continue;
  if (!scopeSelects(scope, slug, entry.private)) continue;
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
  // limit, outage) fails the plan instead of silently skipping repos. The
  // raw content is read only for a modules: filter and never printed.
  const adoption = captureNetwork([
    "gh",
    "api",
    `repos/${slug}/contents/.repo-platform.yml`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (adoption.exitCode !== 0) {
    // stderr only: a failed or timed-out read can leave file content on
    // stdout, target-owned text that may name other private repos.
    if (/HTTP 404/.test(adoption.stderr)) {
      notice(notAdoptedNotice(display));
      continue;
    }
    error(`adoption check failed for ${display}: ${scrubSlug(adoption.stderr, slug, display)}`);
    process.exit(1);
  }
  // A filter judges the declared list; a list it cannot read is reported
  // and left out (the writer's own selection would fail on it), a repo it
  // leaves out is counted, never named (it may be private).
  const filters = modulesFilterFor(scope, slug);
  if (filters !== null) {
    const declared = declaredModules(adoption.stdout);
    if (declared === null) {
      warning(
        `${display}: its .repo-platform.yml has no readable top-level modules list, so the modules filter cannot judge it - left out of this run; fix the file (the sync would fail on it too), then dispatch the repo by slug or re-run.`,
      );
      continue;
    }
    if (!modulesAdmit(filters, declared)) {
      leftOut++;
      continue;
    }
  }
  rows.push({ repo: slug, private: entry.private });
}

const leftOutLine = modulesLeftOutLine(scope, leftOut);
if (leftOutLine !== null) console.log(leftOutLine);
writeFileSync(join(runnerTemp, ROWS_FILE), JSON.stringify(rows));
setOutput("count", String(rows.length));
const line = selectedLine(rows, "syncing", "no adopted repos selected; nothing to sync.");
if (rows.length === 0) notice(line);
else console.log(line);
