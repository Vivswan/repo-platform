#!/usr/bin/env bun
// Reads the target's live repo data for the sync: default branch and
// private flag to GITHUB_OUTPUT; description, homepage, and the
// comma-joined topics to RUNNER_TEMP files (step outputs ride into later
// steps' env-group prints, and a hidden target's values must not). For
// hide-details targets those values and any non-default branch name are
// registered with the masker BEFORE anything is written.
//
// Env: TARGET, TARGET_DISPLAY, HIDE_DETAILS, GH_TOKEN, RUNNER_TEMP,
// GITHUB_OUTPUT.

import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { addMask, env, error, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";

const target = requireEnv("TARGET");
// capture() pipes stderr (the hang bound needs the pipe); re-emit it whole
// so gh's own diagnostics still reach the log as before - with writeSync,
// because an async stream write racing the process.exit below truncates at
// the pipe buffer (~64 KiB).
const proc = capture(["gh", "api", `repos/${target}`]);
writeSync(2, proc.stderr);
if (proc.exitCode !== 0) {
  const display = env("TARGET_DISPLAY");
  error(
    proc.timedOut
      ? `cannot read ${display}: the repository read timed out (proc.ts hang bound); re-run the sync`
      : `cannot read ${display}: the REPO_PLATFORM_TOKEN cannot access it. Grant the PAT access to ${display} (repository access list) with Contents and Pull requests read/write, then re-run.`,
  );
  process.exit(1);
}
const info = parseJsonWith(
  z.object({
    default_branch: z.string(),
    description: z.string().nullable(),
    homepage: z.string().nullable(),
    topics: z.array(z.string()),
    private: z.boolean(),
  }),
  proc.stdout,
  "read_target: repos/<target> response",
);
const branch = info.default_branch;
const description = info.description ?? "";
const homepage = info.homepage ?? "";
// The starter's `topics` answer is the comma-separated form copier asks for.
const topics = info.topics.join(",");
const runnerTemp = requireEnv("RUNNER_TEMP");
writeFileSync(join(runnerTemp, "description.txt"), `${description}\n`);
writeFileSync(join(runnerTemp, "homepage.txt"), `${homepage}\n`);
writeFileSync(join(runnerTemp, "topics.txt"), `${topics}\n`);
if (hideDetails()) {
  // addMask escapes %/CR/LF: workflow-command data must be single-line,
  // or the runner misparses the command and the raw value hits the log.
  // GitHub descriptions cannot hold real newlines, but this must not
  // depend on that staying true. Short values stay unmasked: masking a
  // three-letter topic would garble every log line containing it.
  for (const value of [description, homepage, ...info.topics]) {
    if (value.length >= 4) addMask(value);
  }
  // An unusual branch name is target-derived, whatever its length; only
  // main/master stay unmasked (masking those would garble every log line
  // containing them, and they disclose nothing).
  if (branch !== "main" && branch !== "master") {
    addMask(branch);
  }
}
setOutput("default_branch", branch);
setOutput("private", String(info.private));
