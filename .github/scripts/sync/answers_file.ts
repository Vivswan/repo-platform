// The target's .copier-answers.yml, parsed once at the trust boundary.
// The file is target-controlled input; the sync's consumers read it
// through this module instead of re-scanning lines with their own
// semantics.

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface CopierAnswers {
  /** The recorded _commit VERBATIM, or "" when absent or not a string.
   * Read under the failsafe schema: copier writes with PyYAML (YAML 1.1),
   * which leaves short shas like 1626e53 or 0089012 bare, and the default
   * YAML 1.2 schema would resolve them as numbers ("1.626e+56", "89012").
   * Failsafe keeps every scalar a string while still undoing copier's
   * to_nice_yaml quoting of ambiguous values. */
  commit: string;
  /** Every recorded answer, for field-specific consumers. */
  fields: Record<string, unknown>;
}

/** Thrown for a file this module cannot shape into CopierAnswers. The
 * message can quote target file content - hide-details callers must not
 * print it. */
export class AnswersFileError extends Error {}

function commitOf(text: string): string {
  // logLevel error: the parser's default level prints warned-on source
  // lines (an explicit !!tag) to stderr, which would leak target-controlled
  // file content past the callers' hide-details handling. "error" silences
  // warnings only - real parse errors still throw ("silent" would swallow
  // those too).
  const raw = parse(text, { schema: "failsafe", logLevel: "error" }) as Record<string, unknown>;
  const value = raw._commit;
  return typeof value === "string" ? value : "";
}

export function readAnswersFile(path: string): CopierAnswers {
  const text = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = parse(text, { logLevel: "error" });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new AnswersFileError(`cannot read as YAML: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AnswersFileError("top level must be a mapping");
  }
  return { commit: commitOf(text), fields: parsed as Record<string, unknown> };
}
