#!/usr/bin/env bun
// The label preflight leg of the settings apply job behind run_hidden.ts:
// it runs BEFORE the settings action applies, so the action's own
// private-repos redaction cannot cover what it prints, and it quotes
// repo-owned content (label names, file paths) when it fails. The operator
// repository IS this checkout, so its reference files are read from disk;
// every other target is fetched, pinned to the commit the layers step
// published (PINNED). The argv is a function of the workflow-provided env
// only, never of repository content (the settings-label-preflight ssot
// rule pins it).
//
// Usage: settings_layer_step.ts labels
// Env: TARGET, GITHUB_REPOSITORY, RUNNER_TEMP, PINNED, MODE.

import { join } from "node:path";
import { env, error, requireEnv } from "../shared/gha.ts";
import { must } from "../shared/proc.ts";

export const LAYER_STEPS = ["labels"] as const;
export type LayerStep = (typeof LAYER_STEPS)[number];

export function isLayerStep(value: string | undefined): value is LayerStep {
  return (LAYER_STEPS as readonly string[]).includes(value ?? "");
}

export interface LayerStepFacts {
  /** The resolved slug (already registered with the masker for a redacted row). */
  target: string;
  /** The target is this repository: the reference files come from the checkout. */
  operator: boolean;
  runnerTemp: string;
  /** The commit the layers step published; the fetched leg pins to it. */
  pinned: string;
  /** apply or check, mirrored from the settings action's mode input. */
  mode: string;
}

const SCRIPTS = join(import.meta.dir, "..");

const LEGS: Record<LayerStep, (facts: LayerStepFacts) => { label: string; command: string[] }> = {
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
 *  script owns their validation and refuses an unpinned fetch or a bad
 *  mode with its own diagnostics. */
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
