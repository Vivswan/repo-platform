#!/usr/bin/env bun
// The public signal for a settings target the apply job skipped. Outside
// the hidden capture on purpose: for a hide-details target the capture
// swallows the layers step's skip warning and the freshness step's moved
// warning alike, so without this line each skip is a green job with no
// signal. HINT is the row's masked hint and the reason one of the fixed
// categories, so the notice says WHICH target skipped and why without
// saying anything about its contents.
//
// Env: HINT (matrix.repo), SKIP_REASON (the layers step's skip_reason
// output: left-management, not-onboarded, or empty when the freshness
// step found the branch moved).

import { env, notice, requireEnv } from "../shared/gha.ts";
import type { SkipReason } from "./settings_layers.ts";

export function skippedTargetNotice(hint: string, reason: SkipReason | ""): string {
  if (reason === "left-management") {
    return (
      `settings apply skipped for ${hint}: it carries no .repo-platform.yml at the revision this run read ` +
      "(it left management), so its settings are not managed here any more."
    );
  }
  if (reason === "not-onboarded") {
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

/** Anything but a known category reads as the moved skip: the workflow
 *  passes an empty reason when the layers step published none. */
export function skipReasonFrom(value: string): SkipReason | "" {
  return value === "left-management" || value === "not-onboarded" ? value : "";
}

if (import.meta.main) {
  notice(skippedTargetNotice(requireEnv("HINT"), skipReasonFrom(env("SKIP_REASON"))));
}
