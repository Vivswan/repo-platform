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
import { env, error, hideDetails, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { identityArgs, SYNC_IDENTITY } from "../shared/git_identity.ts";
import { must } from "../shared/proc.ts";

const canonical = `gh:${requireEnv("GITHUB_REPOSITORY")}`;
const display = env("TARGET_DISPLAY");
const answersPath = "target/.copier-answers.yml";
const before = readFileSync(answersPath);

// The normalization itself: extract the recorded value, rewrite the line.
// No print touches the recorded value here - it is target-derived, and the
// hide-details discipline below decides what may reach the public log.
const text = before.toString("utf-8");
const match = text.match(/^_src_path:.*$/m);
if (match === null) {
  if (hideDetails()) {
    error(
      `normalizing ${display}'s recorded template source failed (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md.`,
    );
  } else {
    error(`no _src_path line in ${answersPath}`);
  }
  process.exit(1);
}
const recorded = match[0].replace(/^_src_path:\s*/, "");
writeFileSync(answersPath, text.replace(/^_src_path:.*$/m, `_src_path: ${canonical}`));

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
