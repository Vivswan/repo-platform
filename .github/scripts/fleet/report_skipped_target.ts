#!/usr/bin/env bun
// The public signal for a settings target the apply job skipped. Outside
// the hidden capture on purpose: for a hide-details target the capture
// swallows the merge step's not-onboarded warning and the freshness
// step's moved warning alike, so without this line each skip is a green
// job with no signal. HINT is the row's masked hint, so the notice says
// WHICH target without saying anything about its contents.
//
// Env: HINT (matrix.repo), RENDER_SKIPPED and MERGE_SKIPPED (the steps'
// skipped outputs, "true" when the step skipped).

import { env, notice, requireEnv } from "../shared/gha.ts";

export function skippedTargetNotice(
  hint: string,
  renderSkipped: boolean,
  mergeSkipped: boolean,
): string {
  if (renderSkipped) {
    return (
      `settings apply skipped for ${hint}: it carries no .repo-platform.yml at the revision this run read ` +
      "(it left management), so its settings are not managed here any more."
    );
  }
  if (mergeSkipped) {
    return (
      `settings apply skipped for ${hint}: it has no .github/settings.yml yet, so there is nothing to layer ` +
      "over the fleet defaults. The settings starter seeds the file on its next template sync."
    );
  }
  return (
    `settings apply skipped for ${hint}: its default branch moved while this run was computing its settings, ` +
    "so the apply was skipped rather than applied from a stale snapshot. The next run reads the new revision."
  );
}

if (import.meta.main) {
  notice(
    skippedTargetNotice(
      requireEnv("HINT"),
      env("RENDER_SKIPPED") === "true",
      env("MERGE_SKIPPED") === "true",
    ),
  );
}
