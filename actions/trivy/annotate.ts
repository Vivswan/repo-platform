// Every push and pull request's Trivy scan, read from Trivy's JSON: each finding is a warning annotation on its
// target, so the step stays green and the annotations are the verdict (docs/modules/security-scans.md).

import { readFileSync } from "node:fs";
import { setFailed, warning } from "@actions/core";
import { messageOf, requireEnv } from "../shared/action_runtime.ts";

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;

type Severity = (typeof SEVERITIES)[number];

interface Finding {
  severity: Severity;
  line: string;
}

interface TargetReport {
  target: string;
  findings: Finding[];
}

interface Vulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  PrimaryURL?: string;
}

interface Misconfiguration {
  ID?: string;
  Title?: string;
  Severity?: string;
  Resolution?: string;
  PrimaryURL?: string;
  CauseMetadata?: { StartLine?: number };
}

interface TrivyResult {
  Target?: string;
  Vulnerabilities?: Vulnerability[];
  Misconfigurations?: Misconfiguration[];
}

function severity(value: string | undefined): Severity {
  return (SEVERITIES as readonly string[]).includes(value ?? "") ? (value as Severity) : "UNKNOWN";
}

function vulnerabilityFinding(v: Vulnerability): Finding {
  const fix = v.FixedVersion ? `fixed in ${v.FixedVersion}` : "no fix released";
  return {
    severity: severity(v.Severity),
    line: `${v.VulnerabilityID} ${v.PkgName} ${v.InstalledVersion} (${fix}): ${v.Title ?? ""} ${v.PrimaryURL ?? ""}`.trim(),
  };
}

function misconfigurationFinding(m: Misconfiguration): Finding {
  const at = m.CauseMetadata?.StartLine === undefined ? "" : ` line ${m.CauseMetadata.StartLine}`;
  return {
    severity: severity(m.Severity),
    line: `${m.ID}${at}: ${m.Title ?? ""}. ${m.Resolution ?? ""} ${m.PrimaryURL ?? ""}`.trim(),
  };
}

/** The scanned targets with findings, each target's worst severity first. */
function collectFindings(json: unknown): TargetReport[] {
  const results = (json as { Results?: TrivyResult[] } | null)?.Results ?? [];
  const reports: TargetReport[] = [];
  for (const result of results) {
    const findings: Finding[] = [
      ...(result.Vulnerabilities ?? []).map(vulnerabilityFinding),
      ...(result.Misconfigurations ?? []).map(misconfigurationFinding),
    ];
    if (findings.length === 0) continue;

    findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
    reports.push({ target: result.Target ?? "(unnamed target)", findings });
  }

  return reports;
}

/** The count per severity present, worst first: `2 CRITICAL, 1 HIGH`. */
function severitySummary(findings: Finding[]): string {
  return SEVERITIES.map(
    (level) => [level, findings.filter((f) => f.severity === level).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([level, count]) => `${count} ${level}`)
    .join(", ");
}

function main(): number {
  const reports = collectFindings(JSON.parse(readFileSync(requireEnv("RESULTS"), "utf-8")));
  const all = reports.flatMap((report) => report.findings);
  if (all.length === 0) {
    console.log("trivy found nothing");
    return 0;
  }

  for (const report of reports) {
    for (const finding of report.findings) {
      warning(`${finding.severity} ${finding.line}`, { file: report.target, title: "Trivy" });
    }
  }
  console.log(
    `trivy found ${all.length} finding(s) in ${reports.length} target(s), advisory: ${severitySummary(all)}`,
  );

  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (cause) {
    setFailed(messageOf(cause));
  }
}
