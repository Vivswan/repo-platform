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
// modules:<a>+<b> filters (judged over each adopted repo's declared list
// below), or the literal "all", an explicit whole-fleet scope (never
// ambiguous, since real slugs are always owner/name). RECOVER=recopy requires
// a scope: a recovery re-render clobbers local edits in template-managed
// files and must never fan out across the fleet by accident, so an empty
// repo is rejected.
// Only the input's PRESENCE is judged (its value may be a private slug and
// this log is public); sync-repos.yml fast-fails the same check before
// checkout, and the copy here is the tested backstop. Env: PAT, GH_TOKEN,
// GITHUB_RUN_ID, OWNER, RUNNER_TEMP, GITHUB_OUTPUT, RECOVER, GITHUB_EVENT_PATH.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { declaredModules } from "../../../actions/plan/registration.ts";
import { MODULE_ORDER } from "../../../scripts/lib/module_manifests.ts";
import { env, error, notice, requireEnv, setOutput, warning } from "../shared/gha.ts";
import { parseJson } from "../shared/json.ts";
import {
  captureNetwork,
  notAdoptedNotice,
  pushProbeSkipNotice,
  readDispatchBranch,
  readDispatchRepo,
  scopeSource,
  scrubSlug,
} from "./discovery.ts";
import { pushProbeStatus } from "./push_probe.ts";
import { enrich, parseDiscoveredList, verifyTag } from "./redact.ts";
import {
  branchScopeRefusal,
  modulesAdmit,
  modulesFilterFor,
  modulesLeftOutLine,
  parseScope,
  scopeRefusal,
  scopeSelects,
} from "./sync_scope.ts";

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

const scope = parseScope(scopeInput, new Set(MODULE_ORDER));
if (scope.kind === "error") {
  error(scope.message);
  process.exit(1);
}
// The branch mode's scope guard (sync_scope.ts states the rule; the
// reusable sync judges the branch itself against the target).
const branchRefusal = branchScopeRefusal(scope, readDispatchBranch(), env("RECOVER"));
if (branchRefusal !== null) {
  error(branchRefusal);
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
let leftOut = 0;
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
  // and left out (the leg's own selection would fail on it), a repo it
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
  // The display IS the slug for public rows (enrichedRowSchema holds
  // that invariant), so every matrix row can emit it as its repo.
  repos.push({ repo: row.display, private: row.private, verify: row.verify });
}

const leftOutLine = modulesLeftOutLine(scope, leftOut);
if (leftOutLine !== null) console.log(leftOutLine);
setOutput("repos", JSON.stringify(repos));
if (repos.length === 0) {
  notice("no adopted repos selected; nothing to sync.");
} else {
  console.log(`syncing: ${repos.map((row) => row.repo).join(", ")}`);
}
