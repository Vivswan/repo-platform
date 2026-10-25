#!/usr/bin/env bun

// The local twin of ci.yml's docs-check job. It plays the runner's part: the build's inputs set as the pages-site action's step
// sets them, the site configuration the plan's reading of this repository's registration, and a per-run RUNNER_TEMP removed after.
//
// Usage: bun scripts/docs_check.ts

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { passthrough } from "../.github/scripts/shared/proc.ts";
import {
  loadModuleData,
  outputsOf,
  planSite,
  readRegistration,
  SECURITY_LABEL,
} from "../actions/plan/plan.ts";
import { declaredLabelTuple, reservedLabelNames } from "../actions/plan/reserved_labels.ts";
import { PLATFORM_NAME, PLATFORM_SLUG } from "../actions/shared/platform.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

function siteConfig(): string {
  const files = loadModuleData(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
  const tree = join(REPO_ROOT, "files");
  const plan = planSite({
    registration: readRegistration(REPO_ROOT),
    ...files,
    reservedLabels: reservedLabelNames(files.layers, tree),
    securityLabel: declaredLabelTuple(files.layers, tree, SECURITY_LABEL),
    private: false,
  });
  return outputsOf(plan).config;
}

function main(): number {
  // No-op handlers replace bun's default disposition, which would end the
  // process ahead of the finally; the build shares the terminal's process
  // group, takes the signal, and returns its exit code the normal way.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
  const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_NAME}-docs-check-`));
  try {
    return passthrough(["bun", join(REPO_ROOT, "actions", "pages-site", "build.ts")], {
      cwd: REPO_ROOT,
      env: {
        GITHUB_WORKSPACE: REPO_ROOT,
        GITHUB_REPOSITORY: PLATFORM_SLUG,
        RUNNER_TEMP: scratch,
        CHECK: "true",
        SITE_DIR: "",
        CONFIG: siteConfig(),
        DEFAULT_BRANCH: "main",
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main());
