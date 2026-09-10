#!/usr/bin/env bun
// Split-class files are REBUILT structurally by preserve_local_content.ts:
// copier's merged result is discarded, the managed half comes from the
// clean render, the repo-local half byte-for-byte from the pre-update
// HEAD. Behind run_hidden.ts because carried files are listed in the PR
// body - for a hidden target, ONLY there. Recovery mode has no usable old
// render, so the two render-dir flags stay off and the rebuild runs from
// HEAD alone.
//
// Env: RUNNER_TEMP, HIDE_DETAILS, RECOVER ("recopy" = recovery mode).

import { join } from "node:path";
import { env, requireEnv } from "../shared/gha.ts";
import { must } from "../shared/proc.ts";

export function rebuildArgv(runnerTemp: string, hideDetails: string, recover: string): string[] {
  const renderDirs =
    recover === "recopy"
      ? []
      : [
          "--render-dir",
          `${runnerTemp}/render-new`,
          "--old-render-dir",
          `${runnerTemp}/render-old`,
        ];
  return [
    "bun",
    join(import.meta.dir, "run_hidden.ts"),
    "split-file rebuild",
    "--",
    "bun",
    join(import.meta.dir, "preserve_local_content.ts"),
    "--summary",
    `${runnerTemp}/local-carryover.md`,
    "--root",
    "target",
    "--hide-details",
    hideDetails,
    "--needs-review",
    `${runnerTemp}/carry-review.txt`,
    "--rebuilt-paths",
    `${runnerTemp}/split-rebuilt-paths.txt`,
    ...renderDirs,
  ];
}

if (import.meta.main) {
  must(rebuildArgv(requireEnv("RUNNER_TEMP"), env("HIDE_DETAILS"), env("RECOVER")));
}
