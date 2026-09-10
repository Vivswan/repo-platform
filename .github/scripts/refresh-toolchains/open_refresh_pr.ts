#!/usr/bin/env bun
// Composes the toolchain refresh PR's body - an optional MAJOR banner
// ahead of the fixed summary; Actions expressions cannot build multiline
// strings - and hands it to open_automation_pr.ts over its env, with the
// PR title doubling as the commit message.
//
// Env: BUMPS, MAJOR, PR_TITLE, plus everything open_automation_pr.ts reads.

import { join } from "node:path";
import { env, requireEnv } from "../shared/gha.ts";
import { must } from "../shared/proc.ts";

export function refreshBody(bumps: string, major: string): string {
  const summary =
    `Automated toolchain pin refresh: bump ${bumps} (fleet-wide via the managed version dotfiles - ` +
    "see docs/toolchains.md). Merging this rebuilds the build branch; the next sync pushes it to the fleet.";
  if (major === "") return summary;
  return `**MAJOR VERSION JUMP: ${major} - review before merging.**\n\n${summary}`;
}

if (import.meta.main) {
  must(["bun", join(import.meta.dir, "..", "shared", "open_automation_pr.ts")], {
    env: {
      PR_BODY: refreshBody(requireEnv("BUMPS"), env("MAJOR")),
      COMMIT_MESSAGE: requireEnv("PR_TITLE"),
    },
  });
}
