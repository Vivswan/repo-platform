#!/usr/bin/env bun
// Selects the target's modules for the update (modules.ts filtered
// against the template ref) into $RUNNER_TEMP/modules.json - a file, not
// a step output, because the module list is a target-derived fact and
// step outputs ride into later steps' env-group prints. Hide-details
// targets get counts, not names; modules.ts's failure detail (unknown
// module names, YAML parse text) is captured and withheld for them.
//
// Env: TARGET_DISPLAY, HIDE_DETAILS, RUNNER_TEMP.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, error, hideDetails, notice, requireEnv } from "../shared/gha.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");
const display = env("TARGET_DISPLAY");
const proc = Bun.spawnSync(
  [
    "bun",
    ".github/scripts/sync/modules.ts",
    "--repo-file",
    "target/.repo-platform.yml",
    "--template-copier",
    join(runnerTemp, "copier-new.yml"),
    "--retired-summary",
    join(runnerTemp, "retired-modules.txt"),
  ],
  { stderr: "pipe" },
);
if (proc.exitCode !== 0) {
  if (hideDetails()) {
    error(
      `module selection for ${display} failed (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md.`,
    );
  } else {
    process.stderr.write(proc.stderr);
  }
  process.exit(1);
}
const modules = proc.stdout.toString().trimEnd();
writeFileSync(join(runnerTemp, "modules.json"), modules);

const retiredFile = join(runnerTemp, "retired-modules.txt");
const retired = existsSync(retiredFile)
  ? readFileSync(retiredFile, "utf-8")
      .split("\n")
      .filter((name) => name !== "")
  : [];
if (hideDetails()) {
  console.log(
    `selected modules: ${(JSON.parse(modules) as unknown[]).length} (names hidden: private repository)`,
  );
  if (retired.length > 0) {
    notice(
      `${display}: ${retired.length} retired module(s) dropped from the selection; their files leave the render with this update.`,
    );
  }
} else {
  console.log(`selected modules: ${modules}`);
  for (const name of retired) {
    notice(
      `${display}: retired module '${name}' dropped from the selection; its files leave the render with this update.`,
    );
  }
}
