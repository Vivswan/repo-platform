#!/usr/bin/env bun
// The exit-code contract this reads is action.yml's description.

import { error, setFailed, setOutput } from "@actions/core";
import { env, messageOf } from "../shared/action_runtime.ts";

export type Verdict = { found: boolean } | { error: string };

export function lycheeVerdict(exitCode: string): Verdict {
  if (exitCode === "0") {
    return { found: false };
  }

  if (exitCode === "2") {
    return { found: true };
  }

  return {
    error: `lychee published no verdict: exit code '${exitCode}' (0 = clean, 2 = broken links)`,
  };
}

if (import.meta.main) {
  try {
    const verdict = lycheeVerdict(env("EXIT_CODE"));
    if ("error" in verdict) {
      error(verdict.error);
      process.exit(1);
    }
    setOutput("found", String(verdict.found));
  } catch (cause) {
    setFailed(messageOf(cause));
  }
}
