#!/usr/bin/env bun
// Discovery step of sync-repos.yml's plan job: snapshots the fleet
// owner's slice of the discovered fleet (discovery.ts pre-filters to
// non-archived, user-writable; the token's actual grant is probed per
// repo by the selector) to $RUNNER_TEMP/discovered.json as {repo,
// private} rows for the selector (redact.ts's enrich). Visibility rides
// along fail-closed - anything but private: false counts as private -
// because the `private` flag drives the selector's redaction of this
// public run's logs and matrix (docs/private-repos.md). The log line
// prints only a count and the owner login, never a repo name.
//
// Deliberately stricter than the retired inline jq, which truthiness-
// coerced missing booleans: a listing off the documented shape fails
// loudly (value-free diagnostic) instead of guessing - the same contract
// the other discovery.ts consumers already pin. Real user/repos payloads
// always carry the fields, so the emitted rows are unchanged.
//
// Env: GH_TOKEN (the fleet PAT), RUNNER_TEMP.

import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { requireEnv } from "../shared/gha.ts";
import { captureNetwork, discoverOwnerRepos } from "./discovery.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");

// The owner scope is the PAT's own user: the fleet is the fleet owner's
// repos the token can push to, so cross-owner repos the user can write to
// must not ride into the sync plan. Leaving the fleet = revoking the token's
// write access: a private repo then disappears from this listing (nothing
// deleted); a public one stays listed, and every plan whose scope selects
// that repository prints one notice that the token cannot push to it.
const who = captureNetwork(["gh", "api", "user", "--jq", ".login"]);
if (who.exitCode !== 0) {
  // writeSync: an async stream write racing the process.exit below
  // truncates at the pipe buffer (~64 KiB).
  writeSync(2, who.stderr);
  process.exit(who.exitCode);
}
const login = who.stdout.trim();

const discovered = discoverOwnerRepos(login, "discover_repos: user/repos response");
writeFileSync(join(runnerTemp, "discovered.json"), JSON.stringify(discovered));
console.log(`discovered ${discovered.length} writable repos for ${login}`);
