#!/usr/bin/env bun
// Rewrites the target's recorded _src_path to the canonical template
// source before any copier command (the value is target-controlled and
// never trusted) and commits the rewrite so it rides the update branch
// into the sync PR. The recorded value can be a local filesystem path
// from wherever the repo was generated - target-derived, withheld for
// hide-details targets.
//
// Env: TARGET_DISPLAY, HIDE_DETAILS, GITHUB_REPOSITORY, GITHUB_OUTPUT,
// RUNNER_TEMP.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, error, hideDetails, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { identityArgs, SYNC_IDENTITY } from "../shared/git_identity.ts";
import { must } from "../shared/proc.ts";
import { ANSWERS_PATH, AnswersFileError, readAnswersBytes } from "./answers_file.ts";
import { rewriteSrcPath } from "./src_path.ts";

const canonical = `gh:${requireEnv("GITHUB_REPOSITORY")}`;
const display = env("TARGET_DISPLAY");
const answersPath = join("target", ANSWERS_PATH);
let before: Buffer;
try {
  before = readAnswersBytes("target");
} catch (err) {
  if (!(err instanceof AnswersFileError)) throw err;
  // The boundary's messages name only the path's shape, never its
  // content, so they are safe for a hide-details target's public log.
  error(`${display}'s ${ANSWERS_PATH}: ${err.message}`);
  process.exit(1);
}

// No print touches the recorded value here - it is target-derived, and the
// hide-details discipline below decides what may reach the public log.
const rewrite = rewriteSrcPath(before.toString("utf-8"), canonical);
if (rewrite === null) {
  if (hideDetails()) {
    error(
      `normalizing ${display}'s recorded template source failed (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md.`,
    );
  } else {
    error(`no _src_path line in ${answersPath}`);
  }
  process.exit(1);
}
const recorded = rewrite.recorded;
writeFileSync(answersPath, rewrite.rewritten);

// The commit decision is byte-level (Buffer, not decoded text: utf-8
// decoding maps invalid bytes to U+FFFD, which can read equal while the
// on-disk bytes changed): a rewrite that only reformats the line still
// dirties the tree, and copier update refuses a dirty tree.
if (!readFileSync(answersPath).equals(before)) {
  must([
    "git",
    "-C",
    "target",
    ...identityArgs(SYNC_IDENTITY),
    "commit",
    "-qam",
    `chore: normalize the copier template source to ${canonical}`,
  ]);
  if (recorded === canonical) {
    // Nothing target-specific to hide: the value already was the
    // canonical (public) source; only the line's formatting changed.
    notice(
      `${display}: the _src_path line already recorded '${canonical}' but not byte-for-byte; rewritten canonically for this and future updates.`,
    );
  } else if (hideDetails()) {
    notice(
      `${display}: _src_path was not the canonical template source (recorded value hidden: private repository); rewritten to '${canonical}' for this and future updates.`,
    );
  } else {
    notice(
      `${display}: _src_path was '${recorded}'; rewritten to '${canonical}' (the canonical template source) for this and future updates.`,
    );
  }
}
setOutput("src_path", canonical);
