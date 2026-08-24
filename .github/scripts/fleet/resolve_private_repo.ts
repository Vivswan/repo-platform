#!/usr/bin/env bun
// Resolves a per-repo leg's target from a redacted matrix row. Public job
// names and the auto-printed workflow inputs carry only a display hint and
// an HMAC tag for redacted repos (see .github/scripts/fleet/redact.ts), so
// the leg re-discovers the fleet and picks the repository whose tag
// matches - then registers the slug with the runner's secret masker BEFORE
// any other output, so later steps' env prints, checkout logs, and API
// error bodies render it as ***.
//
// The tag comes from redact.ts's own verifyTag (one implementation for
// both sides; the key is derived from the PAT, never the raw PAT).
// Everything fails closed: an empty tag, a zero-match (repo
// renamed/deleted, grant revoked, or PAT rotated since the plan job), or
// an ambiguous match errors out naming only the hint.
//
// Env in: TARGET_INPUT (slug, or hint when REDACT_NAME=true), REDACT_NAME,
// VERIFY, PAT, GITHUB_RUN_ID, GITHUB_ENV, GITHUB_OUTPUT.
// Out: TARGET + TARGET_DISPLAY via GITHUB_ENV, repo= via GITHUB_OUTPUT.

import { appendFileSync } from "node:fs";
import { addMask, env, error, requireEnv, setOutput } from "../shared/gha.ts";
import { discoverWritableRepos } from "./discovery.ts";
import { verifyTag } from "./redact.ts";

const targetInput = requireEnv("TARGET_INPUT");
const githubEnv = requireEnv("GITHUB_ENV");

if (env("REDACT_NAME", "false") !== "true") {
  appendFileSync(githubEnv, `TARGET=${targetInput}\nTARGET_DISPLAY=${targetInput}\n`);
  setOutput("repo", targetInput);
  process.exit(0);
}

const verify = env("VERIFY");
if (verify === "") {
  error(
    `redacted target ${targetInput} arrived without a resolution tag - the plan job's matrix row is malformed; re-run the whole workflow.`,
  );
  process.exit(1);
}

// An empty key would be publicly known: HMAC(key="") is computable by
// anyone, so an unset or empty PAT must fail before any derivation.
const pat = env("PAT");
if (pat === "") {
  error(
    "PAT is empty or unset - cannot derive the resolution key; check the REPO_PLATFORM_TOKEN wiring.",
  );
  process.exit(1);
}
const runId = requireEnv("GITHUB_RUN_ID");

// Every writable repo, regardless of owner: repos.yml accepts explicit
// entries under other owners, so the search must not assume the fleet
// owner. The candidate slugs are never printed - any may be private.
const candidates = discoverWritableRepos("resolve_private_repo: user/repos response");

const matches = candidates
  .map((repo) => repo.full_name)
  .filter((slug) => verifyTag(pat, runId, slug) === verify);

if (matches.length === 0) {
  error(
    `cannot resolve the plan-time target (${targetInput}): it was renamed or deleted, the token's grant was revoked, or the REPO_PLATFORM_TOKEN was rotated after the plan job ran. Re-run the whole workflow, not just this job.`,
  );
  process.exit(1);
}
if (matches.length > 1) {
  error(
    `the resolution tag for ${targetInput} matched ${matches.length} repositories - refusing to guess; re-run the whole workflow.`,
  );
  process.exit(1);
}
const resolved = matches[0];

// Mask before any output that could carry the slug. The runner's masker is
// case-sensitive and substring-based, so register the canonical and
// lowercase slug forms, and the bare name when it is long enough that
// masking it cannot garble the whole log (a 3-char name like "api" appears
// in too many innocent strings; the hide-details discipline covers its
// diagnostics instead).
addMask(resolved);
const lower = resolved.toLowerCase();
if (lower !== resolved) {
  addMask(lower);
}
const name = resolved.split("/").pop() ?? "";
if (name.length >= 4) {
  addMask(name);
  const lowerName = name.toLowerCase();
  if (lowerName !== name) {
    addMask(lowerName);
  }
}

appendFileSync(githubEnv, `TARGET=${resolved}\nTARGET_DISPLAY=${targetInput}\n`);
setOutput("repo", resolved);
console.log(`resolved the redacted target ${targetInput}`);
