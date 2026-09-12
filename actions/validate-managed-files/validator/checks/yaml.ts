import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parseAllDocuments, parseDocument } from "yaml";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";

/** Duplicate mapping keys do not count as parsing: the last value silently wins at consumption time.
 *  A multi-document stream fails the same way: every consumer reads one mapping and ignores the rest. */
export function checkYaml(ctx: Context): Finding[] {
  const findings: Finding[] = [];
  for (const rel of ctx.files) {
    const suffix = extname(rel);
    if (suffix !== ".yml" && suffix !== ".yaml") continue;
    findings.push(...diagnose(rel, readFileSync(join(ctx.root, rel), "utf-8")));
  }
  return findings;
}

/** doc.errors carries only composer-stage problems, so each document is also converted: a duplicate key must not mask a
 *  resolution failure (an unresolved alias) in the same document. */
function diagnose(rel: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const syntaxError = (m: string) =>
    error(`${rel}: does not parse as YAML (${m}); fix the syntax at the position shown`);
  const firstLine = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
  const docs = parseAllDocuments(text, { uniqueKeys: true });
  // A VALID directive with no document behind it composes zero documents and no stream error (a malformed one carries
  // BAD_DIRECTIVE); only the forced single document reports it. An empty or comment-only file forces an error-free document.
  //   "%YAML 1.2\n"  -> Missing directives-end indicator line
  //   "%TAG\n"       -> %TAG directive should contain exactly two parts, and the missing indicator
  if (docs.length === 0) {
    return parseDocument(text, { uniqueKeys: true }).errors.map((e) => syntaxError(firstLine(e)));
  }
  if (docs.length > 1) {
    findings.push(
      error(
        `${rel}: multi-document YAML stream (${docs.length} documents) - this file's ` +
          "consumers read a single mapping and silently ignore the rest; merge the documents",
      ),
    );
  }
  for (const doc of docs) {
    for (const docError of doc.errors) {
      const message = docError.message.split("\n")[0];
      // Duplicate keys are syntactically valid YAML, so "fix the syntax" would mislead; name the real problem.
      if (docError.code === "DUPLICATE_KEY") {
        findings.push(
          error(
            `${rel}: duplicate mapping key (${message}) - the later value silently ` +
              "wins at consumption time; remove or rename the duplicate",
          ),
        );
      } else {
        findings.push(syntaxError(message));
      }
    }
    try {
      doc.toJS();
    } catch (convError) {
      findings.push(syntaxError(firstLine(convError)));
    }
  }
  return findings;
}
