#!/usr/bin/env bun
// GitHub reserves Pages-site creation to a token the job lacks, whatever `pages: write` grants, so a repository's first deploy can
// precede the settings apply that creates the site (files/site/settings.yml), and 404 means wait for it.

import { appendFileSync, writeSync } from "node:fs";
import {
  capture,
  error,
  failureDetail,
  type RunResult,
  requireEnv,
  warning,
} from "../shared/action_runtime.ts";
import { type IncludedResponse, parseIncludedResponse } from "../shared/gh_api.ts";
import { PLATFORM_NAME } from "../shared/platform.ts";

const GH_TIMEOUT_MS = 60_000;

export type PagesVerdict =
  | { exists: true }
  | { exists: false; warning: string }
  | { exists: null; error: string };

export const NO_SITE_YET =
  `no Pages site yet: ${PLATFORM_NAME}'s settings apply creates it on its next run (daily), ` +
  "and the nightly rebuild deploys; nothing to do here.";

/** 200 -> exists; 404 -> no site yet, a warning; anything else, a missing status included, is an error naming
 *  what came back (`detail` stands in for the body when there was no response at all). */
export function judgePagesAnswer(answer: IncludedResponse, detail: string): PagesVerdict {
  if (answer.status === 200) return { exists: true };
  if (answer.status === 404) return { exists: false, warning: NO_SITE_YET };
  const body = answer.status === null && answer.body === "" ? detail : answer.body;
  return {
    exists: null,
    error: `reading the Pages site answered HTTP ${answer.status ?? "nothing"}${body === "" ? "" : `: ${body}`}`,
  };
}

export function askPages(repository: string): RunResult {
  return capture(["gh", "api", "--include", `repos/${repository}/pages`], {
    timeoutMs: GH_TIMEOUT_MS,
  });
}

if (import.meta.main) {
  const result = askPages(requireEnv("GITHUB_REPOSITORY"));
  // gh's own diagnostics reach the step log whole, as they did when the shell let them through.
  writeSync(2, result.stderr);
  const verdict = judgePagesAnswer(parseIncludedResponse(result.stdout), failureDetail(result));
  if (verdict.exists === null) {
    error(verdict.error);
    process.exit(1);
  }
  if (!verdict.exists) warning(verdict.warning);
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `exists=${verdict.exists}\n`);
}
