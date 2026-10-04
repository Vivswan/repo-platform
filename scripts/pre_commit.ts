#!/usr/bin/env bun

// The pre-commit hook: the static gates only. The site build and the test suite are CI's to judge on every push, and
// running them here too cost each commit about four minutes for a verdict the push repeats minutes later.
//
// Usage: bun scripts/pre_commit.ts

import { spawnSync } from "node:child_process";

/** git exports GIT_DIR and GIT_INDEX_FILE into hooks, which redirects any git subprocess the gates spawn (tests init
 *  scratch repos) at the real repository; a leaked GIT_DIR once rewrote this repo's config to bare. */
function withoutGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
}

if (import.meta.main) {
  const gates = spawnSync("bun", ["run", "check:static"], {
    env: withoutGitEnv(process.env),
    stdio: "inherit",
  });
  process.exit(gates.status ?? 1);
}
