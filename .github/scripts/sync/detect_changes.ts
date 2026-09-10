#!/usr/bin/env bun
// Whether this run has anything to deliver. Uncommitted copier output OR
// commits already on the branch (a migration rung's commit and the
// _src_path normalization commit themselves) both count as changes. A
// failed status is a red step, never a clean tree: it prints nothing, and
// a bare emptiness test would read that as "nothing to deliver". Status
// diagnostics (a warning on a green exit included) go to the log as they
// would from an inherited stderr.
//
// Env: UPSTREAM (the ref the checkout started from), DISPLAY (the
// delivered build), TARGET_DISPLAY, GITHUB_OUTPUT.

import { writeSync } from "node:fs";
import { error, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { capture, mustCapture } from "../shared/proc.ts";

const upstream = requireEnv("UPSTREAM");
const display = requireEnv("DISPLAY");
const targetDisplay = requireEnv("TARGET_DISPLAY");

const ahead = Number(
  mustCapture(["git", "-C", "target", "rev-list", "--count", `origin/${upstream}..HEAD`]),
);
const status = capture(["git", "-C", "target", "status", "--porcelain"]);
if (status.stderr !== "") writeSync(2, status.stderr);
if (status.exitCode !== 0) {
  error("git status failed in the target checkout");
  process.exit(1);
}
if (status.stdout === "" && ahead === 0) {
  notice(`${targetDisplay}: already matches ${display}; nothing to deliver.`);
  setOutput("changed", "false");
} else {
  setOutput("changed", "true");
}
