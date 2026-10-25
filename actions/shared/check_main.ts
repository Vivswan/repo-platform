// The one main for a check that reports findings the fleet way (docs/fleet-guidelines.md): the report is written once,
// to the sticky-comment file on findings, the step summary, and `report=` for the action's comment steps.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { messageOf } from "./action_runtime.ts";

/** The three outcomes an action distinguishes (its `report` output). */
export type Outcome<Verdict> =
  | { state: "findings" | "clean"; verdict: Verdict }
  | { state: "error"; message: string };

/** One annotation: `file` and `line` anchor it on the diff when they are the finding's own. */
export interface Annotation {
  message: string;
  file?: string;
  line?: number;
}

/** The slice of @actions/core the check reports through. The zone cannot carry the package (bun resolves it upward
 *  from the importing file, and an action's node_modules is not above this one), so the action hands its own in. */
export interface Core {
  warning(message: string, properties?: { file?: string; startLine?: number }): void;
  error(message: string, properties?: { file?: string; startLine?: number }): void;
  setOutput(name: string, value: string): void;
  summary: { addRaw(text: string): { write(): Promise<unknown> } };
}

/** What one check hands the shared main; `errors` are the annotations any one of which fails the run. */
export interface CheckProgram<Verdict> {
  name: string;
  check(root: string): Verdict | Promise<Verdict>;
  outcomeOf(verdict: Verdict): Outcome<Verdict>;
  report(outcome: Outcome<Verdict>): string;
  warnings(verdict: Verdict): Annotation[];
  errors(verdict: Verdict): Annotation[];
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
  core: Core,
  argv: string[] = process.argv.slice(2),
): Promise<never> {
  // Cleared first, so a crash below leaves no comment body behind.
  const reportPath = process.env.REPORT_PATH;
  if (reportPath) rmSync(reportPath, { force: true });

  const emit = async (outcome: Outcome<Verdict>): Promise<void> => {
    const body = program.report(outcome);
    if (reportPath && outcome.state === "findings") writeFileSync(reportPath, body);

    if (process.env.GITHUB_STEP_SUMMARY) await core.summary.addRaw(body).write();

    if (process.env.GITHUB_OUTPUT) core.setOutput("report", outcome.state);
  };
  // core prints `::error ::` (a stray space) for a properties object whose every value is unset, so an unanchored
  // annotation passes none.
  const annotate = (kind: "warning" | "error", { message, file, line }: Annotation): void =>
    core[kind](
      message,
      file === undefined && line === undefined ? undefined : { file, startLine: line },
    );
  let verdict: Verdict;
  try {
    verdict = await program.check(rootOf(argv));
  } catch (cause) {
    const message = messageOf(cause);
    core.error(`${program.name} did not run to completion: ${message}`);
    await emit({ state: "error", message });
    process.exit(1);
  }

  for (const warning of program.warnings(verdict)) annotate("warning", warning);

  const errors = program.errors(verdict);
  if (errors.length > 0) {
    for (const error of errors) annotate("error", error);
    console.error(program.failed(errors.length));
  } else {
    console.log(program.passed(verdict));
  }
  // Last, so nothing after it can leave a recorded state the run's exit contradicts.
  await emit(program.outcomeOf(verdict));
  process.exit(errors.length > 0 ? 1 : 0);
}
