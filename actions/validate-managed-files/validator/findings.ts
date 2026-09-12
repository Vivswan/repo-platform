import { writeFileSync } from "node:fs";

export type Finding = { message: string };

export function error(message: string): Finding {
  return { message };
}

/** An empty set writes an EMPTY file rather than none, which is how the action tells "nothing to report" from
 *  "the validator never ran" (src/verdict.ts reads the file as one of its two witnesses). */
export function writeReport(findings: readonly Finding[], env: NodeJS.ProcessEnv): void {
  const path = env.FINDINGS_FILE;
  if (path === undefined || path === "") return;
  const text =
    findings.length === 0
      ? ""
      : `#### Errors (${findings.length})\n\n${findings.map((f) => `- ${f.message}`).join("\n")}\n`;
  writeFileSync(path, text);
}

export function print(findings: readonly Finding[]): number {
  if (findings.length > 0) {
    for (const finding of findings) console.error(`error: ${finding.message}`);
    console.error(`\n${findings.length} error(s).`);
    return 1;
  }
  console.log("Validation passed.");
  return 0;
}
