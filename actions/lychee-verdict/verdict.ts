#!/usr/bin/env bun
// lychee's exit codes are its own: 0 clean, 2 broken links. 1 is lychee's own error, 3 a configuration error, and an
// empty code a step that never ran; none of those is a clean run, so each fails here instead of reading as one.

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
