#!/usr/bin/env bun

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
