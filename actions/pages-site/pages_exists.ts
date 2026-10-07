#!/usr/bin/env bun
// GitHub reserves Pages-site creation to a token the job lacks, whatever `pages: write` grants, so a repository's first deploy can
// precede the settings apply that creates the site (files/site/settings.yml), and 404 means wait for it.

import { appendFileSync } from "node:fs";
import { error, requireEnv, warning } from "../shared/action_runtime.ts";
import { type Answer, answerText, github } from "../shared/github.ts";
import { PLATFORM_NAME } from "../shared/platform.ts";

export type PagesVerdict =
  | { exists: true }
  | { exists: false; warning: string }
  | { exists: null; error: string };

export const NO_SITE_YET =
  `no Pages site yet: ${PLATFORM_NAME}'s settings apply creates it on its next run (daily), ` +
  "and the nightly rebuild deploys; nothing to do here.";

/** 200 -> exists; 404 -> no site yet, a warning; anything else, no response included, is an error naming what came back. */
export function judgePagesAnswer(answer: Answer): PagesVerdict {
  if (answer.status === 200) return { exists: true };
  if (answer.status === 404) return { exists: false, warning: NO_SITE_YET };
  return { exists: null, error: `reading the Pages site answered ${answerText(answer)}` };
}

if (import.meta.main) {
  const verdict = judgePagesAnswer(await github(`repos/${requireEnv("GITHUB_REPOSITORY")}/pages`));
  if (verdict.exists === null) {
    error(verdict.error);
    process.exit(1);
  }
  if (!verdict.exists) warning(verdict.warning);
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `exists=${verdict.exists}\n`);
}
