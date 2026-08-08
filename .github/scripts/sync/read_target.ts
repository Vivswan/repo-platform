#!/usr/bin/env bun
// Reads the target's live repo data for the sync: default branch and
// private flag to GITHUB_OUTPUT, description to a RUNNER_TEMP file (step
// outputs ride into later steps' env-group prints, and a hidden target's
// description must not). For hide-details targets the description and any
// non-default branch name are registered with the masker BEFORE either
// value is written anywhere.
//
// Env: TARGET, TARGET_DISPLAY, HIDE_DETAILS, GH_TOKEN, RUNNER_TEMP,
// GITHUB_OUTPUT.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { addMask, env, error, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { parseWith } from "../shared/json.ts";

const target = requireEnv("TARGET");
const proc = Bun.spawnSync(["gh", "api", `repos/${target}`], { stderr: "inherit" });
if (proc.exitCode !== 0) {
  const display = env("TARGET_DISPLAY");
  error(
    `cannot read ${display}: the REPO_PLATFORM_TOKEN cannot access it. Grant the PAT access to ${display} (repository access list) with Contents and Pull requests read/write, then re-run.`,
  );
  process.exit(1);
}
const info = parseWith(
  z.object({
    default_branch: z.string(),
    description: z.string().nullable(),
    private: z.boolean(),
  }),
  JSON.parse(proc.stdout.toString()),
  "read_target: repos/<target> response",
);
const branch = info.default_branch;
const description = info.description ?? "";
writeFileSync(join(requireEnv("RUNNER_TEMP"), "description.txt"), `${description}\n`);
if (hideDetails()) {
  // addMask escapes %/CR/LF: workflow-command data must be single-line,
  // or the runner misparses the command and the raw value hits the log.
  // GitHub descriptions cannot hold real newlines, but this must not
  // depend on that staying true.
  if (description.length >= 4) {
    addMask(description);
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
