#!/usr/bin/env bun
// Discovery step of sync-repos.yml's plan job: snapshots the fleet
// owner's slice of the discovered fleet (discovery.ts pre-filters to
// non-archived, user-writable; the token's actual grant is probed per
// repo by the selector) to $RUNNER_TEMP/discovered.json as {repo,
// private} rows for the selection pipeline (repos_registry select,
// redact enrich). Visibility rides along fail-closed - anything but
// private: false counts as private - because the `private` flag drives
// the selector's redaction of this public run's logs and matrix
// (docs/private-repos.md). The log line prints only a count and the
// owner login, never a repo name.
//
// Deliberately stricter than the retired inline jq, which truthiness-
// coerced missing booleans: a listing off the documented shape fails
// loudly (value-free diagnostic) instead of guessing - the same contract
// the other discovery.ts consumers already pin. Real user/repos payloads
// always carry the fields, so the emitted rows are unchanged.
//
// Env: GH_TOKEN (the fleet PAT), RUNNER_TEMP.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireEnv } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";
import { discoverOwnerRepos } from "./discovery.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");

// The owner scope is the PAT's own user: repos.yml's wildcard means
// "every repo of the fleet owner", so cross-owner repos the user can
// write to must not ride into the sync plan.
const who = capture(["gh", "api", "user", "--jq", ".login"]);
if (who.exitCode !== 0) {
  process.stderr.write(who.stderr);
  process.exit(who.exitCode);
}
const login = who.stdout.trim();

const discovered = discoverOwnerRepos(login, "discover_repos: user/repos response");
writeFileSync(join(runnerTemp, "discovered.json"), JSON.stringify(discovered));
console.log(`discovered ${discovered.length} writable repos for ${login}`);
