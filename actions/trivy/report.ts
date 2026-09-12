// The fuzz-issue action's report directory (docs/fuzzer.md, contract v1): one subdirectory per scanned target with a report.md.
// A finding's matched secret text never leaves the JSON: the report names the rule, the file, and the line.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { requireEnv } from "../shared/action_runtime.ts";
import { IGNORE_FILE } from "./ignore_check.ts";

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SCANNERS = "vuln,misconfig,secret";
/** The nightly scan's filter; the replay must see what the scan saw. */
export const SCAN_SEVERITY = "HIGH,CRITICAL";
/** The report's row cap: the issue shows the heading plus 60 lines. */
export const MAX_ROWS = 50;

export interface Finding {
  severity: Severity;
  line: string;
}

export interface TargetReport {
  target: string;
  findings: Finding[];
}

interface TrivyResult {
  Target?: string;
  Vulnerabilities?: {
    VulnerabilityID?: string;
    PkgName?: string;
    InstalledVersion?: string;
    FixedVersion?: string;
    Severity?: string;
    Title?: string;
    PrimaryURL?: string;
  }[];
  Misconfigurations?: {
    ID?: string;
    Title?: string;
    Severity?: string;
    Resolution?: string;
    PrimaryURL?: string;
    CauseMetadata?: { StartLine?: number };
  }[];
  Secrets?: {
    RuleID?: string;
    Title?: string;
    Severity?: string;
    StartLine?: number;
  }[];
}

function severity(value: string | undefined): Severity {
  return (SEVERITIES as readonly string[]).includes(value ?? "") ? (value as Severity) : "UNKNOWN";
}

export function collectFindings(json: unknown): TargetReport[] {
  const results = (json as { Results?: TrivyResult[] } | null)?.Results ?? [];
  const reports: TargetReport[] = [];
  for (const result of results) {
    const findings: Finding[] = [];
    for (const v of result.Vulnerabilities ?? []) {
      const fix = v.FixedVersion ? `fixed in ${v.FixedVersion}` : "no fix released";
      findings.push({
        severity: severity(v.Severity),
        line: `${v.VulnerabilityID} ${v.PkgName} ${v.InstalledVersion} (${fix}): ${v.Title ?? ""} ${v.PrimaryURL ?? ""}`.trim(),
      });
    }
    for (const m of result.Misconfigurations ?? []) {
      const at =
        m.CauseMetadata?.StartLine === undefined ? "" : ` line ${m.CauseMetadata.StartLine}`;
      findings.push({
        severity: severity(m.Severity),
        line: `${m.ID}${at}: ${m.Title ?? ""}. ${m.Resolution ?? ""} ${m.PrimaryURL ?? ""}`.trim(),
      });
    }
    for (const s of result.Secrets ?? []) {
      const at = s.StartLine === undefined ? "" : ` line ${s.StartLine}`;
      findings.push({
        severity: severity(s.Severity),
        line: `${s.RuleID}${at}: ${s.Title ?? ""}`.trim(),
      });
    }
    if (findings.length === 0) continue;
    findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
    reports.push({ target: result.Target ?? "(unnamed target)", findings });
  }
  return reports;
}

export function severitySummary(findings: Finding[]): string {
  return SEVERITIES.map(
    (level) => [level, findings.filter((f) => f.severity === level).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([level, count]) => `${count} ${level}`)
    .join(", ");
}

export function reportBody(report: TargetReport): string {
  const count = report.findings.length;
  // The replay names the bypass file unconditionally: Trivy skips a missing ignore file.
  const lines = [
    `# ${report.target}: ${count} finding${count === 1 ? "" : "s"}`,
    "",
    `Nightly Trivy scan, ${severitySummary(report.findings)}. Replay from the repository root:`,
    "",
    "```",
    `trivy fs --scanners ${SCANNERS} --severity ${SCAN_SEVERITY} --ignorefile ${IGNORE_FILE} ${shellWord(report.target)}`,
    "```",
    "",
    ...report.findings.slice(0, MAX_ROWS).map((f) => `- ${f.severity} ${f.line}`),
  ];
  if (count > MAX_ROWS)
    lines.push(`- and ${count - MAX_ROWS} more; the run's artifact carries the full JSON`);
  lines.push("");
  return lines.join("\n");
}

export function shellWord(path: string): string {
  return /^[A-Za-z0-9._/@:+=-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

export const MAX_NAME = 100;

export function directoryName(target: string, taken: Set<string>): string {
  let base = target.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "") || "target";
  if (base.length > MAX_NAME) {
    const digest = createHash("sha256").update(target).digest("hex").slice(0, 8);
    base = `${base.slice(0, MAX_NAME - digest.length - 1)}-${digest}`;
  }
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

export const RESULTS_NAME = "trivy.json";

/** The report directory, recreated: empty on a clean scan (the artifact
 *  and the issue steps read an existing directory either way). With
 *  findings, Trivy's full JSON rides at the top level, which the issue
 *  action ignores but the uploaded artifact keeps. */
export function writeReports(reports: TargetReport[], reportDir: string, results?: string): void {
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });
  if (reports.length > 0 && results !== undefined) {
    copyFileSync(results, join(reportDir, RESULTS_NAME));
  }
  const taken = new Set<string>([RESULTS_NAME]);
  for (const report of reports) {
    const dir = join(reportDir, directoryName(report.target, taken));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), reportBody(report));
  }
}

function main(): number {
  const reportDir = requireEnv("REPORT_DIR");
  const output = requireEnv("GITHUB_OUTPUT");
  const results = requireEnv("RESULTS");
  const reports = collectFindings(JSON.parse(readFileSync(results, "utf-8")));
  writeReports(reports, reportDir, results);
  const all = reports.flatMap((report) => report.findings);
  appendFileSync(
    output,
    `findings=${all.length}\nfound=${all.length > 0}\nreport-dir=${reportDir}\n`,
  );
  if (all.length === 0) {
    console.log("trivy found nothing");
    return 0;
  }
  console.log(
    `trivy found ${all.length} finding(s) in ${reports.length} target(s): ${severitySummary(all)}`,
  );
  for (const report of reports) {
    console.log(`  ${report.target}: ${severitySummary(report.findings)}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main());
