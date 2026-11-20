import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "./bounded_spawn";
import { interpolate } from "./github_expression";
import { parseGithubOutput } from "./github_output";

export const REPO_ROOT = join(import.meta.dir, "../..");
export const RUNNER_BASH = ["/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c"];

export type Step = Record<string, unknown>;

export interface Action {
  name: string;
  description: string;
  inputs?: Record<string, { description: string; required?: boolean; default?: string }>;
  outputs?: Record<string, { description: string; value: string }>;
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

/** The step run under the runner's bash, its `env:` and `run:` filled once over `context`: each key a dotted path
 *  (`inputs.label`), each value what the runner would hand the step. */
export function runBashStep(
  step: Step,
  options: {
    context?: Record<string, string | boolean>;
    env?: Record<string, string>;
    cwd: string;
    root: string;
    timeoutMs?: number;
  },
): StepRun {
  const filled = (text: string): string => interpolate(text, options.context ?? {});
  const outputs = join(options.root, `${String(step.id ?? step.name)}-outputs.txt`);
  writeFileSync(outputs, "");
  const stepEnv = Object.fromEntries(
    Object.entries((step.env ?? {}) as Record<string, string>).map(([k, v]) => [k, filled(v)]),
  );
  const proc = boundedSpawnSync([...RUNNER_BASH, filled(String(step.run))], {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      ...stepEnv,
      ...(options.env ?? {}),
      GITHUB_OUTPUT: outputs,
    },
    timeoutMs: options.timeoutMs,
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    outputs: parseGithubOutput(readFileSync(outputs, "utf8")),
  };
}
