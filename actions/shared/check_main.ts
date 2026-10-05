// The one main for a check that reports findings the fleet way (docs/fleet-guidelines.md): the report is written once,
// to the sticky-comment file on findings, the step summary, and `report=` for the action's comment steps.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { workflowCommand } from "./action_runtime.ts";

/** The three outcomes an action distinguishes (its `report` output). */
export type Outcome<Verdict> =
  | { state: "findings" | "clean"; verdict: Verdict }
  | { state: "error"; message: string };

export interface CheckProgram<Verdict> {
  name: string;
  check(root: string): Verdict | Promise<Verdict>;
  outcomeOf(verdict: Verdict): Outcome<Verdict>;
  report(outcome: Outcome<Verdict>): string;
  /** `::warning` commands, to stdout. */
  warnings(verdict: Verdict): string[];
  /** `::error` commands, to stderr; any one fails the run. */
  errors(verdict: Verdict): string[];
  passed(verdict: Verdict): string;
  failed(count: number): string;
}

/** The one optional argument is the checkout root; the current directory otherwise. */
export function rootOf(argv: string[]): string {
  if (argv.length > 1) throw new Error(`unexpected argument(s): ${argv.slice(1).join(" ")}`);
  return resolve(argv[0] ?? ".");
}

export async function runCheck<Verdict>(
  program: CheckProgram<Verdict>,
  argv: string[] = process.argv.slice(2),
): Promise<never> {
  // Cleared first, so a crash below leaves no comment body behind.
  const reportPath = process.env.REPORT_PATH;
  if (reportPath) rmSync(reportPath, { force: true });
  const emit = (outcome: Outcome<Verdict>): void => {
    const body = program.report(outcome);
    if (reportPath && outcome.state === "findings") writeFileSync(reportPath, body);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `report=${outcome.state}\n`);
  };
  let verdict: Verdict;
  try {
    verdict = await program.check(rootOf(argv));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      workflowCommand("error", `${program.name} did not run to completion: ${message}`),
    );
    emit({ state: "error", message });
    process.exit(1);
  }
  for (const warning of program.warnings(verdict)) console.log(warning);
  const errors = program.errors(verdict);
  if (errors.length > 0) {
    for (const line of errors) console.error(line);
    console.error(program.failed(errors.length));
  } else {
    console.log(program.passed(verdict));
  }
  // Last, so nothing after it can leave a recorded state the run's exit contradicts.
  emit(program.outcomeOf(verdict));
  process.exit(errors.length > 0 ? 1 : 0);
}
