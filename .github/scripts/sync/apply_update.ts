#!/usr/bin/env bun
// Applies the template to the target checkout: a three-way `copier update`
// normally, or a full `copier recopy` in recovery mode - for a repo whose
// recorded _commit base is unusable, there is no merge base, so the
// re-render overwrites template-managed files outright (`_skip_if_exists`
// files survive; copier deletes nothing; the PR is forced onto the
// manual-review path). Invoked by reusable-template-sync.yml's "Apply
// copier update" step.
//
// Env: TARGET_DIR (default target), TARGET_REF, MODULES, PRIVATE,
// DESCRIPTION, RECOVER.

import { env, requireEnv } from "../shared/gha.ts";
import { passthrough } from "../shared/proc.ts";

const subcommand = env("RECOVER") === "recopy" ? ["recopy", "--overwrite"] : ["update"];
process.exit(
  passthrough(
    [
      "copier",
      ...subcommand,
      // Where copier READS the recorded answers as well as writes them:
      // the subproject read honors only this flag or the hardcoded root
      // default - never the template's _answers_file - so every update
      // and recopy must name the landed path explicitly (measured on
      // copier 9.17.0).
      "--answers-file",
      ".github/.copier-answers.yml",
      "--vcs-ref",
      requireEnv("TARGET_REF"),
      "--defaults",
      "--trust",
      "-d",
      `modules=${requireEnv("MODULES")}`,
      "-d",
      `private=${requireEnv("PRIVATE")}`,
      "-d",
      `description=${env("DESCRIPTION")}`,
    ],
    { cwd: env("TARGET_DIR", "target") },
  ),
);
