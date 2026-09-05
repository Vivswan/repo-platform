import { writeFileSync } from "node:fs";

/** One diagnostic. Errors fail the run; advisories are printed and never
 *  touch the exit code. */
export type Finding = { severity: "error" | "advisory"; message: string };

export function error(message: string): Finding {
  return { severity: "error", message };
}

export function advisory(message: string): Finding {
  return { severity: "advisory", message };
}

export function errorsOf(findings: readonly Finding[]): string[] {
  return findings.filter((f) => f.severity === "error").map((f) => f.message);
}

export function advisoriesOf(findings: readonly Finding[]): string[] {
  return findings.filter((f) => f.severity === "advisory").map((f) => f.message);
}

/** Findings as markdown, in TWO separate files because the two streams
 *  have different consequences: errors are what this process exits nonzero
 *  on, advisories never touch the exit code (one combined file once made a
 *  caller treat "has content" as "blocks"). Both are opt-in through
 *  FINDINGS_FILE / ADVISORIES_FILE. An empty set writes an EMPTY file
 *  rather than none, which is how a caller tells "nothing to report" from
 *  "the validator never ran". */
export function writeReports(findings: readonly Finding[], env: NodeJS.ProcessEnv): void {
  const section = (title: string, items: string[]): string =>
    items.length === 0
      ? ""
      : `#### ${title} (${items.length})\n\n${items.map((i) => `- ${i}`).join("\n")}\n`;
  const write = (variable: string, text: string): void => {
    const path = env[variable];
    if (path !== undefined && path !== "") writeFileSync(path, text);
  };
  write("FINDINGS_FILE", section("Errors", errorsOf(findings)));
  write("ADVISORIES_FILE", section("Advisories", advisoriesOf(findings)));
}

/** Prints advisories to stdout and errors to stderr; returns the exit code. */
export function print(findings: readonly Finding[]): number {
  for (const message of advisoriesOf(findings)) console.log(`advisory: ${message}`);
  const errors = errorsOf(findings);
  if (errors.length > 0) {
    for (const message of errors) console.error(`error: ${message}`);
    console.error(`\n${errors.length} error(s).`);
    return 1;
  }
  console.log("Validation passed.");
  return 0;
}
