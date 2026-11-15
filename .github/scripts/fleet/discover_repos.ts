#!/usr/bin/env bun
// Only a count and the owner login reach the public log; each row's `private` flag decides what the selector may name later
// (docs/platform/sync/private-repositories.md).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { error } from "@actions/core";
import { z } from "zod";
import { requireEnv } from "../shared/gha.ts";
import { GitHubClient, unansweredReason } from "../shared/github.ts";
import { discoverOwnerRepos } from "./discovery.ts";

/** Where the discovered list is written for the selectors. */
const runnerTemp = requireEnv("RUNNER_TEMP");

// The owner scope is the PAT's own user: cross-owner repos the user can write to must not ride into the sync plan.
const who = await new GitHubClient().get("user", z.object({ login: z.string() }));

if (who.kind !== "ok") {
  error(`discover_repos: the token's user could not be read (${unansweredReason(who)})`);
  process.exit(1);
}
const login = who.value.login;

const discovered = discoverOwnerRepos(login, "discover_repos: user/repos response");
writeFileSync(join(runnerTemp, "discovered.json"), JSON.stringify(discovered));
console.log(`discovered ${discovered.length} writable repos for ${login}`);
