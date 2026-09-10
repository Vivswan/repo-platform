// Runs one composite-action bash step the way the runner does: the step's
// `run` with its `${{ ... }}` expressions filled from the caller's map,
// its env: block applied, and the GITHUB_OUTPUT it wrote parsed back.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "./bounded_spawn";

export const REPO_ROOT = join(import.meta.dir, "../..");
const RUNNER_BASH = ["/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c"];

export type Step = Record<string, unknown>;

export interface Action {
  name: string;
  inputs?: Record<string, { description: string; required?: boolean; default?: string }>;
  runs: { using: string; steps: Step[] };
}

export function loadAction(rel: string): Action {
  return parseYaml(readFileSync(join(REPO_ROOT, rel), "utf8")) as Action;
}

export function stepNamed(action: Action, name: string): Step {
  const step = action.runs.steps.find((s) => s.name === name);
  if (step === undefined) throw new Error(`no step named '${name}'`);
  return step;
}

export interface StepRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
}

/** Every `${{ ... }}` in `text` replaced from `fills`; an expression the
 *  caller did not fill throws, so a step never runs with a literal one. */
export function fill(text: string, fills: Record<string, string>): string {
  let filled = text;
  for (const [expr, value] of Object.entries(fills)) filled = filled.replaceAll(expr, value);
  if (filled.includes("${{")) throw new Error(`unresolved expression in ${filled}`);
  return filled;
}

export function runBashStep(
  step: Step,
  options: {
    fills?: Record<string, string>;
    env?: Record<string, string>;
    cwd: string;
    root: string;
  },
): StepRun {
  const fills = options.fills ?? {};
  const outputs = join(options.root, `${String(step.id ?? step.name)}-outputs.txt`);
  writeFileSync(outputs, "");
  const stepEnv = Object.fromEntries(
    Object.entries((step.env ?? {}) as Record<string, string>).map(([k, v]) => [k, fill(v, fills)]),
  );
  const proc = boundedSpawnSync([...RUNNER_BASH, fill(String(step.run), fills)], {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      ...stepEnv,
      ...(options.env ?? {}),
      GITHUB_OUTPUT: outputs,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    outputs: Object.fromEntries(
      readFileSync(outputs, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    ),
  };
}
