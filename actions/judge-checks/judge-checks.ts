// A composite action sees only its own steps, so the job's `steps` context arrives as JSON. `conclusion` decides, not
// `outcome`: a check under continue-on-error is advisory by the caller's choice, and GitHub records its failure as success.

import { appendFileSync } from "node:fs";
import { error, requireEnv } from "../shared/action_runtime.ts";

interface StepResult {
  outcome: string;
  conclusion: string;
}

/** GitHub resolves an input the caller never passed to the empty string with no error, so an empty context is refused. */
function parseSteps(json: string): Record<string, StepResult> {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("STEPS is not a steps context (an object keyed by step id)");
  }
  const steps = parsed as Record<string, { outcome?: unknown; conclusion?: unknown }>;
  for (const [id, result] of Object.entries(steps)) {
    if (typeof result?.outcome !== "string" || typeof result?.conclusion !== "string") {
      throw new Error(`step '${id}' carries no outcome and conclusion`);
    }
  }
  if (Object.keys(steps).length === 0) {
    throw new Error("the steps context is empty: pass the job's toJSON(steps)");
  }
  return steps as Record<string, StepResult>;
}

function verdict(conclusion: string): string {
  if (conclusion === "success") return "ok";
  if (conclusion === "skipped") return "stood down";
  return "FAILED";
}

function summaryTable(steps: Record<string, StepResult>): string {
  const rows = Object.entries(steps).map(
    ([id, result]) => `| ${id} | ${result.outcome} | ${verdict(result.conclusion)} |`,
  );
  return `## Standard checks\n\n| check | outcome | verdict |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
}

function main(): number {
  const steps = parseSteps(requireEnv("STEPS"));
  appendFileSync(requireEnv("GITHUB_STEP_SUMMARY"), summaryTable(steps));
  const failed = Object.entries(steps)
    .filter(([, result]) => verdict(result.conclusion) === "FAILED")
    .map(([id]) => id);
  if (failed.length === 0) {
    console.log("every check passed");
    return 0;
  }
  for (const id of failed) error(`check failed: ${id}`);
  return 1;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
