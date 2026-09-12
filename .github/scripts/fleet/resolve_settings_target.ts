#!/usr/bin/env bun
// The settings apply's row resolver: sync/resolve_row.ts's step under the apply's own GITHUB_ENV
// contract, TARGET alone (settings-repos.yml reads it as the action's repos input).

import { fail, notice, requireEnv } from "../shared/gha.ts";
import { resolveTarget } from "../sync/resolve_row.ts";
import { supersededBy, supersededNotice } from "./newest_main.ts";

const sha = requireEnv("GITHUB_SHA");

// Newest wins is asked at the write (docs/settings.md), before the listing: the plan asked too, but a re-run of failed rows
// reuses the plan's answer, and by then a newer commit's run may have applied. No TARGET skips the apply step, so the row
// stands down green.
let newer: string | null;
try {
  newer = supersededBy(sha);
} catch (lookFailure) {
  fail(lookFailure instanceof Error ? lookFailure.message : String(lookFailure));
}
if (newer !== null) {
  notice(supersededNotice(sha, newer));
  process.exit(0);
}

resolveTarget("resolve_settings_target", (target) => `TARGET=${target.repo}\n`);
