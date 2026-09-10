#!/usr/bin/env bun
// One leg of the settings apply job - render, merge, or labels - behind
// run_hidden.ts: all three run BEFORE the settings action, so its own
// private-repos redaction cannot cover what they print, and all three
// quote repo-owned content when they fail. The operator repository IS
// this checkout, so its facts and its layer are read from disk (the
// render took its facts from the same working tree, and fetching would
// reintroduce the race the pin removes); every other target is fetched,
// pinned to the commit the render published (PINNED).
//
// Usage: settings_layer_step.ts render|merge|labels
// Env: TARGET, GITHUB_REPOSITORY, RUNNER_TEMP; PINNED (merge, labels); MODE (labels).

import { join } from "node:path";
import { env, error, requireEnv } from "../shared/gha.ts";
import { must } from "../shared/proc.ts";

export const LAYER_STEPS = ["render", "merge", "labels"] as const;
export type LayerStep = (typeof LAYER_STEPS)[number];

export function isLayerStep(value: string | undefined): value is LayerStep {
  return (LAYER_STEPS as readonly string[]).includes(value ?? "");
}

export interface LayerStepFacts {
  /** The resolved slug (already registered with the masker for a redacted row). */
  target: string;
  /** The target is this repository: facts and layer come from the checkout. */
  operator: boolean;
  runnerTemp: string;
  /** The commit the render published; the fetched legs pin to it. */
  pinned: string;
  /** apply or check, mirrored from the settings action's mode input. */
  mode: string;
}

const SCRIPTS = join(import.meta.dir, "..");

const LEGS: Record<LayerStep, (facts: LayerStepFacts) => { label: string; command: string[] }> = {
  render: (facts) => ({
    label: "settings render",
    command: [
      "bun",
      join(SCRIPTS, "fleet", "render_managed_settings.ts"),
      "--repo",
      facts.target,
      ...(facts.operator ? ["--operator-answers", ".repo-platform-answers.yml"] : []),
      "--out",
      `${facts.runnerTemp}/managed-settings.yml`,
    ],
  }),
  merge: (facts) => ({
    label: "settings merge",
    command: [
      "bun",
      join(SCRIPTS, "fleet", "merge_settings_layers.ts"),
      "--managed",
      `${facts.runnerTemp}/managed-settings.yml`,
      ...(facts.operator
        ? ["--repo-file", ".github/settings.yml"]
        : ["--repo-fetch", facts.target, "--repo-ref", facts.pinned]),
      "--out",
      `${facts.runnerTemp}/merged-settings.yml`,
    ],
  }),
  labels: (facts) => ({
    label: "settings labels",
    command: [
      "bun",
      join(SCRIPTS, "fleet", "label_preflight.ts"),
      "--merged",
      `${facts.runnerTemp}/merged-settings.yml`,
      "--repo",
      facts.target,
      ...(facts.operator ? ["--target-dir", "."] : ["--ref", facts.pinned]),
      "--mode",
      facts.mode,
    ],
  }),
};

/** The whole argv of one leg: the wrapper, its capture label, then the
 *  leg's command. The wrapper is applied here and nowhere else, so no
 *  leg can run unwrapped. */
export function layerStepArgv(step: LayerStep, facts: LayerStepFacts): string[] {
  const { label, command } = LEGS[step](facts);
  return ["bun", join(SCRIPTS, "sync", "run_hidden.ts"), label, "--", ...command];
}

/** PINNED and MODE pass through as given (empty when unset): the called
 *  scripts own their validation and refuse an unpinned fetch or a bad
 *  mode with their own diagnostics. */
export function factsFromEnv(): LayerStepFacts {
  const target = requireEnv("TARGET");
  return {
    target,
    operator: target === requireEnv("GITHUB_REPOSITORY"),
    runnerTemp: requireEnv("RUNNER_TEMP"),
    pinned: env("PINNED"),
    mode: env("MODE"),
  };
}

if (import.meta.main) {
  const step = process.argv[2];
  if (!isLayerStep(step)) {
    error(`settings_layer_step.ts: expected one of ${LAYER_STEPS.join(", ")}, got '${step ?? ""}'`);
    process.exit(2);
  }
  must(layerStepArgv(step, factsFromEnv()));
}
