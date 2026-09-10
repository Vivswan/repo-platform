#!/usr/bin/env bun
// Runs the conflict resolver toward the template and publishes `resolved`
// for the review flag on the PR: true when the resolver dropped local
// hunks (its summary file is non-empty), false otherwise. Not wrapped in
// run_hidden.ts: the resolver hides its own detail for a hidden target.
//
// Env: RUNNER_TEMP, HIDE_DETAILS, GITHUB_OUTPUT.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { env, requireEnv, setOutput } from "../shared/gha.ts";
import { must } from "../shared/proc.ts";

export function resolveArgv(runnerTemp: string, hideDetails: string): string[] {
  return [
    "bun",
    join(import.meta.dir, "resolve_copier_conflicts.ts"),
    "--summary",
    `${runnerTemp}/dropped-local-hunks.md`,
    "--root",
    "target",
    "--skip",
    `${runnerTemp}/split-rebuilt-paths.txt`,
    "--hide-details",
    hideDetails,
  ];
}

if (import.meta.main) {
  const runnerTemp = requireEnv("RUNNER_TEMP");
  must(resolveArgv(runnerTemp, env("HIDE_DETAILS")));
  const summary = `${runnerTemp}/dropped-local-hunks.md`;
  setOutput("resolved", String(existsSync(summary) && statSync(summary).size > 0));
}
