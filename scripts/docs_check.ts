#!/usr/bin/env bun

// `bun run docs:check`: the Docs Site workflow's PR check (the pages-site
// action's strict CHECK build) over this repo's docs/, with the env that
// job's action step sets, so an exported shell variable cannot change the
// build. RUNNER_TEMP is per run and removed in the finally: the action's
// scratch is otherwise one fixed path under the system tmpdir that it never
// cleans and that concurrent worktrees would wipe from under each other.
//
// Usage: bun scripts/docs_check.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { passthrough } from "../.github/scripts/shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

function main(): number {
  // No-op handlers replace bun's default disposition, which would end the
  // process ahead of the finally; the build shares the terminal's process
  // group, takes the signal, and returns its exit code the normal way.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
  const scratch = mkdtempSync(join(tmpdir(), "repo-platform-docs-check-"));
  try {
    return passthrough(["bun", join(REPO_ROOT, "actions", "pages-site", "build.ts")], {
      cwd: REPO_ROOT,
      env: {
        GITHUB_WORKSPACE: REPO_ROOT,
        GITHUB_REPOSITORY: "Vivswan/repo-platform",
        RUNNER_TEMP: scratch,
        MOUNTS: '[{"path": "/", "source": "vitepress", "versioned": true}]',
        CHECK: "true",
        DOCS_DIR: "docs",
        SITE_TITLE: "repo-platform",
        INSTALL_COMMAND: "",
        BUILD_COMMAND: "",
        CALLER_PATH: process.env.PATH ?? "",
        DIST_DIR: "dist",
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
