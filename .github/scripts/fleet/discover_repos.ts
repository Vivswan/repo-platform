#!/usr/bin/env bun
// Only a count and the owner login reach the public log; each row's `private` flag decides what the selector may name later
// (docs/sync.md).

import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { requireEnv } from "../shared/gha.ts";
import { captureNetwork, discoverOwnerRepos } from "./discovery.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");

// The owner scope is the PAT's own user: cross-owner repos the user can write to must not ride into the sync plan.
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
