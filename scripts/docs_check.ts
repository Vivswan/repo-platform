#!/usr/bin/env bun

// The local twin of ci.yml's docs-check job; the build inputs are set here the way the pages-site action's step sets them, so an
// exported copy of one cannot change the build. RUNNER_TEMP is per run and removed in the finally: the action's scratch is otherwise
// one fixed path under the system tmpdir that it never cleans and that concurrent worktrees would wipe from under each other.
//
// Usage: bun scripts/docs_check.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { passthrough } from "../.github/scripts/shared/proc.ts";
import { PLATFORM_NAME, PLATFORM_SLUG } from "../actions/shared/platform.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The configuration ci.yml's docs-check and site jobs pass (the site-config-parity ssot rule pins the three). */
const SITE_CONFIG =
  '{"site_title": "repo-platform", "docs_path": "docs", "include": [], "link_rot_label": "docs-link-rot"}';

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
        CONFIG: SITE_CONFIG,
        MAX_VERSIONS: "5",
        CUSTOM_DOMAIN: "",
        DEFAULT_BRANCH: "main",
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main());
