import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { type EmptyStream, parseAllDocuments } from "yaml";
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
  // A stream with no document (a directive alone, "%TAG") carries its errors on the stream, not on a document.
  if (docs.length === 0) {
    return (docs as EmptyStream).errors.map((streamError) => syntaxError(firstLine(streamError)));
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
