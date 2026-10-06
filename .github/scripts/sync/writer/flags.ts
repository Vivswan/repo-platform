import { parseArgs } from "node:util";
import { fail } from "../../shared/gha.ts";

/** `--flag value` pairs under node's strict parser, so an unknown flag or a valueless one is refused by name; then every
 *  required flag must be present. Flags are named bare (`target`, spelled `--target` on the command line). */
export function parseFlags<R extends string, O extends string = never>(
  argv: string[],
  required: readonly R[],
  optional: readonly O[] = [],
): Record<R, string> & Partial<Record<O, string>> {
  const options = Object.fromEntries(
    [...required, ...optional].map((flag) => [flag, { type: "string" }] as const),
  );
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({ args: argv, options, strict: true }).values;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const missing = required.filter((flag) => values[flag] === undefined);
  if (missing.length > 0) {
    fail(`missing required flags: ${missing.map((flag) => `--${flag}`).join(", ")}`);
  }
  return values as Record<R, string> & Partial<Record<O, string>>;
}
