#!/usr/bin/env bun
// The exit-code contract this reads is action.yml's description.

import { appendFileSync } from "node:fs";
import { env, error, requireEnv } from "../shared/action_runtime.ts";

export type Verdict = { found: boolean } | { error: string };

export function lycheeVerdict(exitCode: string): Verdict {
  if (exitCode === "0") return { found: false };
  if (exitCode === "2") return { found: true };
  return {
    error: `lychee published no verdict: exit code '${exitCode}' (0 = clean, 2 = broken links)`,
  };
}

if (import.meta.main) {
  const verdict = lycheeVerdict(env("EXIT_CODE"));
  if ("error" in verdict) {
    error(verdict.error);
    process.exit(1);
  }
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `found=${verdict.found}\n`);
}
