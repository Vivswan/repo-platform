import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parseAllDocuments, parse as parseYaml } from "yaml";
import type { Context } from "../context.ts";
import { advisory, error, type Finding } from "../findings.ts";

/** Whether a duplicate mapping key in this path is an error rather than an
 *  advisory. Strict for .github/ (the answers file lives there) plus the
 *  root registration file: GitHub's own parsers reject duplicate keys
 *  there anyway, and a three-way merge can duplicate settings.yml's
 *  identity keys, where the later value silently wins at apply time.
 *  Elsewhere a duplicate can be deliberate (a parser fixture, a vendored
 *  config) - and a sync walks the whole target repo, so erroring there
 *  would make every sync PR permanently red. */
function isStrictYaml(rel: string): boolean {
  return rel === ".repo-platform.yml" || rel.startsWith(".github/");
}

/** Every .yml/.yaml file parses. Duplicate mapping keys do not count as
 *  parsing (the last value silently wins at consumption time); a
 *  multi-document stream is an error in the strict set, whose consumers
 *  read one mapping and would silently ignore the rest. */
export function checkYaml(ctx: Context): Finding[] {
  const findings: Finding[] = [];
  for (const rel of ctx.files) {
    const suffix = extname(rel);
    if (suffix !== ".yml" && suffix !== ".yaml") continue;
    const text = readFileSync(join(ctx.root, rel), "utf-8");
    try {
      parseYaml(text, { uniqueKeys: true });
    } catch (exc) {
      findings.push(...diagnose(rel, text, exc));
    }
  }
  return findings;
}

/** parse() throws only its first error and refuses multi-document sources
 *  outright, so a failed file is re-parsed per document: a valid
 *  multi-document file passes and every real error is reported. doc.errors
 *  carries only composer-stage problems, so each document is also
 *  converted - a duplicate key must not mask a resolution failure (an
 *  unresolved alias) that parse() would have thrown. */
function diagnose(rel: string, text: string, exc: unknown): Finding[] {
  const findings: Finding[] = [];
  const syntaxError = (m: string) =>
    error(`${rel}: does not parse as YAML (${m}); fix the syntax at the position shown`);
  // Duplicate keys are syntactically valid YAML, so "fix the syntax" would
  // mislead; name the real problem.
  const duplicateReport = (m: string) =>
    `${rel}: duplicate mapping key (${m}) - the later value silently ` +
    "wins at consumption time; remove or rename the duplicate";
  const firstLine = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
  const docs = parseAllDocuments(text, { uniqueKeys: true });
  if (docs.length > 1 && isStrictYaml(rel)) {
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
      if (docError.code !== "DUPLICATE_KEY") findings.push(syntaxError(message));
      else if (isStrictYaml(rel)) findings.push(error(duplicateReport(message)));
      else findings.push(advisory(duplicateReport(message)));
    }
    try {
      doc.toJS();
    } catch (convError) {
      findings.push(syntaxError(firstLine(convError)));
    }
  }
  // An exception the per-document re-parse does not surface still fails.
  if (findings.length === 0 && (exc as { code?: string }).code !== "MULTIPLE_DOCS") {
    findings.push(syntaxError(firstLine(exc)));
  }
  return findings;
}
