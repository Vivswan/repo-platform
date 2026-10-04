#!/usr/bin/env bun
// GitHub reserves Pages-site creation to a token other than the job's, whatever `pages: write` grants, so a deploy
// can only ask whether the site exists. A repository's first deploy after selecting the site module can run before
// the settings apply that creates the site (files/site/settings.yml), and the one known answer, 404, is "wait for
// the apply", never a failure.

import { appendFileSync, writeSync } from "node:fs";
import {
  capture,
  error,
  failureDetail,
  type RunResult,
  requireEnv,
  warning,
} from "../shared/action_runtime.ts";
import { PLATFORM_NAME } from "../shared/platform.ts";

const GH_TIMEOUT_MS = 60_000;

export interface PagesAnswer {
  /** The HTTP status `gh api --include` printed, or null when it printed no status line. */
  status: number | null;
  /** The response body, one line. */
  body: string;
}

/** `gh api --include` prints the status line, the headers (CRLF), a blank line, and the body, exit 1 off 2xx.
 *  The body is folded to one line the way the shell did it: CRs dropped, runs of newlines and spaces to one space. */
export function parseIncludedResponse(stdout: string): PagesAnswer {
  const status = /^HTTP\/[0-9.]+ (\d{3})\b/.exec(stdout);
  const separator = /\r?\n\r?\n/.exec(stdout);
  const body = separator === null ? "" : stdout.slice(separator.index + separator[0].length);
  return {
    status: status === null ? null : Number(status[1]),
    body: body
      .replaceAll("\r", "")
      .replaceAll(/[\n ]+/g, " ")
      .replace(/ $/, ""),
  };
}

export type PagesVerdict =
  | { exists: true }
  | { exists: false; warning: string }
  | { exists: null; error: string };

export const NO_SITE_YET =
  `no Pages site yet: ${PLATFORM_NAME}'s settings apply creates it on its next run (daily), ` +
  "and the nightly rebuild deploys; nothing to do here.";

/** 200 -> exists; 404 -> no site yet, a warning; anything else, a missing status included, is an error naming
 *  what came back (`detail` stands in for the body when there was no response at all). */
export function judgePagesAnswer(answer: PagesAnswer, detail: string): PagesVerdict {
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
