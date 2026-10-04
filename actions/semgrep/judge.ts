#!/usr/bin/env bun
// The verdict, from two witnesses in order: the scan's exit status (a scan that did not complete has no verdict,
// whatever its JSON copy says), then the JSON copy (ERROR findings and fatal analysis errors fail; warn-level
// analysis errors, partial parses and timeouts, are semgrep's limits and only annotate).

import { readFileSync } from "node:fs";
import { env, error, requireEnv, warning } from "../shared/action_runtime.ts";
import { jsonPath } from "./reports.ts";

interface SemgrepJson {
  results: { extra: { severity: string } }[];
  errors: { level: string }[];
}

export interface Judgment {
  warnings: string[];
  errors: string[];
}

export function judgeStatus(status: string): string | null {
  return status === "0"
    ? null
    : `semgrep: the scan did not complete (exit status ${status === "" ? "none" : status}), so there is no verdict; see the scan log above`;
}

export function judgeReport(report: SemgrepJson): Judgment {
  const findings = report.results.filter((result) => result.extra.severity === "ERROR").length;
  const fatal = report.errors.filter((problem) => problem.level === "error").length;
  const nonfatal = report.errors.length - fatal;
  return {
    warnings:
      nonfatal === 0
        ? []
        : [
            `semgrep: ${nonfatal} non-fatal analysis error(s) (partial parses, timeouts); see the scan log above`,
          ],
    errors:
      findings === 0 && fatal === 0
        ? []
        : [
            `semgrep: ${findings} ERROR-severity finding(s), ${fatal} fatal analysis error(s); see the scan log above`,
          ],
  };
}

if (import.meta.main) {
  // An unrun scan step's output is empty (GitHub): refused as "none", never read as 0 findings.
  const incomplete = judgeStatus(env("SCAN_STATUS"));
  if (incomplete !== null) {
    error(incomplete);
    process.exit(1);
  }
  const judgment = judgeReport(
    JSON.parse(readFileSync(jsonPath(requireEnv("RUNNER_TEMP")), "utf8")) as SemgrepJson,
  );
  for (const message of judgment.warnings) warning(message);
  for (const message of judgment.errors) error(message);
  if (judgment.errors.length > 0) process.exit(1);
}
