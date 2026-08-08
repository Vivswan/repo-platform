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

import { env, error, hideDetails, notice, requireEnv, setOutput } from "../shared/gha.ts";

const canonical = `gh:${requireEnv("GITHUB_REPOSITORY")}`;
const display = env("TARGET_DISPLAY");
const normalize = Bun.spawnSync(
  [
    "bun",
    ".github/scripts/sync/normalize_src_path.ts",
    "--answers",
    "target/.copier-answers.yml",
    "--canonical",
    canonical,
  ],
  { stderr: "pipe" },
);
if (normalize.exitCode !== 0) {
  if (hideDetails()) {
    error(
      `normalizing ${display}'s recorded template source failed (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md.`,
    );
  } else {
    process.stderr.write(normalize.stderr);
  }
  process.exit(1);
}
const recorded = normalize.stdout.toString().replace(/\n+$/, "");
if (recorded !== canonical) {
  // copier update refuses a dirty tree, so the rewrite is committed.
  const commit = Bun.spawnSync(
    [
      "git",
      "-C",
      "target",
      "-c",
      "user.name=repo-platform-sync",
      "-c",
      "user.email=repo-platform-sync@users.noreply.github.com",
      "commit",
      "-qam",
      `chore: normalize the copier template source to ${canonical}`,
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (commit.exitCode !== 0) process.exit(commit.exitCode ?? 1);
  if (hideDetails()) {
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
