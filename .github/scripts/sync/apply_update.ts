#!/usr/bin/env bun
// Applies the template to the target checkout: a three-way `copier update`
// normally, or a full `copier recopy` in recovery mode - for a repo whose
// recorded _commit base is unusable, there is no merge base, so the
// re-render overwrites template-managed files outright (`_skip_if_exists`
// files survive; copier deletes nothing; the PR is forced onto the
// manual-review path). Invoked by reusable-template-sync.yml's "Apply
// copier update" step.
//
// Env: TARGET_DIR (default target), TARGET_REF, MODULES, CHANNEL, PRIVATE,
// DESCRIPTION, RECOVER.

import { env, requireEnv } from "../shared/gha.ts";

const subcommand = env("RECOVER") === "recopy" ? ["recopy", "--overwrite"] : ["update"];
const proc = Bun.spawnSync(
  [
    "copier",
    ...subcommand,
    "--vcs-ref",
    requireEnv("TARGET_REF"),
    "--defaults",
    "--trust",
    "-d",
    `modules=${requireEnv("MODULES")}`,
    "-d",
    `channel=${requireEnv("CHANNEL")}`,
    "-d",
    `private=${requireEnv("PRIVATE")}`,
    "-d",
    `description=${env("DESCRIPTION")}`,
  ],
  { cwd: env("TARGET_DIR", "target"), stdio: ["inherit", "inherit", "inherit"] },
);
process.exit(proc.exitCode ?? 1);
