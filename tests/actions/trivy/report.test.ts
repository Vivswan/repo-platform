// report.ts: Trivy's JSON to the fuzz-issue report directory, judged pure
// (grouping, ordering, the row cap, directory names) and through the
// script the action step runs (the directories on disk and the
// GITHUB_OUTPUT rows) on a scan with findings and on a clean one.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectFindings,
  directoryName,
  MAX_NAME,
  MAX_ROWS,
  RESULTS_NAME,
  reportBody,
  severitySummary,
  shellWord,
  writeReports,
} from "../../../actions/trivy/report";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/trivy/report.ts");

const RESULTS = {
  SchemaVersion: 2,
  Results: [
    { Target: "bun.lock", Class: "lang-pkgs", Type: "bun" },
    {
      Target: "actions/pages-site/bun.lock",
      Class: "lang-pkgs",
      Type: "bun",
      Vulnerabilities: [
        {
          VulnerabilityID: "GHSA-67mh-4wv8-2f99",
          PkgName: "esbuild",
          InstalledVersion: "0.21.5",
          FixedVersion: "0.25.0",
          Severity: "MEDIUM",
          Title: "esbuild enables any website to send any requests to the development server",
          PrimaryURL: "https://github.com/advisories/GHSA-67mh-4wv8-2f99",
        },
        {
          VulnerabilityID: "CVE-2026-1",
          PkgName: "left-pad",
          InstalledVersion: "1.0.0",
          Severity: "CRITICAL",
          Title: "left-pad: padding overflow",
          PrimaryURL: "https://avd.aquasec.com/nvd/cve-2026-1",
        },
        { VulnerabilityID: "CVE-2026-2", PkgName: "odd", InstalledVersion: "1", Severity: "WEIRD" },
      ],
    },
    {
      Target: "Dockerfile",
      Class: "config",
      Type: "dockerfile",
      Misconfigurations: [
        {
          ID: "DS-0002",
          Title: "Image user should not be 'root'",
          Severity: "HIGH",
          Resolution: "Add 'USER <non root user name>' line to the Dockerfile",
          PrimaryURL: "https://avd.aquasec.com/misconfig/ds-0002",
        },
        {
          ID: "DS-0026",
          Title: "No HEALTHCHECK defined",
          Severity: "LOW",
          Resolution: "Add HEALTHCHECK instruction in your Dockerfile",
          PrimaryURL: "https://avd.aquasec.com/misconfig/ds-0026",
          CauseMetadata: { StartLine: 1 },
        },
      ],
    },
    {
      Target: "tests/fixtures/keys.env",
      Class: "secret",
      Secrets: [
        {
          RuleID: "aws-access-key-id",
          Category: "AWS",
          Severity: "CRITICAL",
          Title: "AWS Access Key ID",
          StartLine: 3,
          Match: "AKIA****************",
        },
      ],
    },
  ],
};

describe("collectFindings", () => {
  test("groups by target, drops clean targets, orders worst severity first, and never carries a secret's match", () => {
    const reports = collectFindings(RESULTS);
    expect(reports.map((report) => report.target)).toEqual([
      "actions/pages-site/bun.lock",
      "Dockerfile",
      "tests/fixtures/keys.env",
    ]);
    expect(reports[0].findings).toEqual([
      {
        severity: "CRITICAL",
        line: "CVE-2026-1 left-pad 1.0.0 (no fix released): left-pad: padding overflow https://avd.aquasec.com/nvd/cve-2026-1",
      },
      {
        severity: "MEDIUM",
        line: "GHSA-67mh-4wv8-2f99 esbuild 0.21.5 (fixed in 0.25.0): esbuild enables any website to send any requests to the development server https://github.com/advisories/GHSA-67mh-4wv8-2f99",
      },
      { severity: "UNKNOWN", line: "CVE-2026-2 odd 1 (no fix released):" },
    ]);
    expect(reports[1].findings.map((f) => f.line)).toEqual([
      "DS-0002: Image user should not be 'root'. Add 'USER <non root user name>' line to the Dockerfile https://avd.aquasec.com/misconfig/ds-0002",
      "DS-0026 line 1: No HEALTHCHECK defined. Add HEALTHCHECK instruction in your Dockerfile https://avd.aquasec.com/misconfig/ds-0026",
    ]);
    expect(reports[2].findings).toEqual([
      { severity: "CRITICAL", line: "aws-access-key-id line 3: AWS Access Key ID" },
    ]);
    expect(JSON.stringify(reports)).not.toContain("AKIA");
  });

  test("no Results, or an empty document, is no findings", () => {
    expect(collectFindings({})).toEqual([]);
    expect(collectFindings(null)).toEqual([]);
    expect(collectFindings({ Results: [{ Target: "bun.lock" }] })).toEqual([]);
  });
});

describe("reportBody", () => {
  test("a contract-v1 report: the heading names the target, the replay block comes first, then one row per finding", () => {
    const body = reportBody(collectFindings(RESULTS)[1]);
    expect(body.split("\n")).toEqual([
      "# Dockerfile: 2 findings",
      "",
      "Nightly Trivy scan, 1 HIGH, 1 LOW. Replay from the repository root:",
      "",
      "```",
      "trivy fs --scanners vuln,misconfig,secret --ignorefile .trivyignore.yaml Dockerfile",
      "```",
      "",
      "- HIGH DS-0002: Image user should not be 'root'. Add 'USER <non root user name>' line to the Dockerfile https://avd.aquasec.com/misconfig/ds-0002",
      "- LOW DS-0026 line 1: No HEALTHCHECK defined. Add HEALTHCHECK instruction in your Dockerfile https://avd.aquasec.com/misconfig/ds-0026",
      "",
    ]);
  });

  test("rows past the cap fold into one line so the issue keeps the whole report", () => {
    const findings = Array.from({ length: MAX_ROWS + 7 }, (_, i) => ({
      severity: "LOW" as const,
      line: `CVE-${i}`,
    }));
    const lines = reportBody({ target: "big.lock", findings }).split("\n");
    expect(lines[0]).toBe(`# big.lock: ${MAX_ROWS + 7} findings`);
    expect(lines.filter((line) => line.startsWith("- ")).length).toBe(MAX_ROWS + 1);
    expect(lines.at(-2)).toBe("- and 7 more; the run's artifact carries the full JSON");
    // The fuzz-issue action keeps the heading plus 60 lines.
    expect(lines.length).toBeLessThanOrEqual(62);
  });

  test("severitySummary lists the non-zero levels, worst first", () => {
    expect(severitySummary(collectFindings(RESULTS).flatMap((r) => r.findings))).toBe(
      "2 CRITICAL, 1 HIGH, 1 MEDIUM, 1 LOW, 1 UNKNOWN",
    );
  });
});

describe("directoryName", () => {
  test("a target path becomes a contract-conforming name, unique within the run", () => {
    const taken = new Set<string>();
    const names = [
      "actions/pages-site/bun.lock",
      "actions_pages-site_bun.lock",
      "./Dockerfile",
      "../escape",
      "",
    ].map((target) => directoryName(target, taken));
    expect(names).toEqual([
      "actions_pages-site_bun.lock",
      "actions_pages-site_bun.lock-2",
      "Dockerfile",
      "escape",
      "target",
    ]);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  test("a flattened path past the filesystem's name limit keeps its head plus a hash of the whole", () => {
    const deep = `${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(100)}/package-lock.json`;
    const name = directoryName(deep, new Set());
    expect(name).toHaveLength(MAX_NAME);
    expect(name).toMatch(/^a{91}-[0-9a-f]{8}$/);
    expect(directoryName(`${deep}x`, new Set())).not.toBe(name);
  });
});

describe("writeReports", () => {
  test("a target named like the full-results file gets the allocator's suffix instead of colliding", () => {
    const dir = join(temp.dir("trivy-write-"), "report");
    const results = join(temp.dir("trivy-results-"), "scan.json");
    writeFileSync(results, "{}");
    const reports = collectFindings({
      Results: [
        {
          Target: RESULTS_NAME,
          Class: "secret",
          Secrets: [
            { RuleID: "github-pat", Severity: "CRITICAL", Title: "GitHub PAT", StartLine: 1 },
          ],
        },
      ],
    });
    writeReports(reports, dir, results);
    expect(readdirSync(dir).sort()).toEqual([RESULTS_NAME, `${RESULTS_NAME}-2`]);
    expect(readFileSync(join(dir, RESULTS_NAME), "utf-8")).toBe("{}");
    expect(existsSync(join(dir, `${RESULTS_NAME}-2`, "report.md"))).toBe(true);
  });
});

describe("shellWord", () => {
  test("a plain path stays bare; spaces and quotes get single-quoted so the replay is one argument", () => {
    expect(shellWord("actions/pages-site/bun.lock")).toBe("actions/pages-site/bun.lock");
    expect(shellWord("examples/my app/package-lock.json")).toBe(
      "'examples/my app/package-lock.json'",
    );
    expect(shellWord("it's/Dockerfile")).toBe("'it'\\''s/Dockerfile'");
    expect(
      reportBody({ target: "my app/bun.lock", findings: [{ severity: "LOW", line: "x" }] }),
    ).toContain(
      "\ntrivy fs --scanners vuln,misconfig,secret --ignorefile .trivyignore.yaml 'my app/bun.lock'\n",
    );
  });
});

describe("the report step", () => {
  const run = (results: unknown) => {
    const dir = temp.dir("trivy-report-");
    const resultsPath = join(dir, "trivy.json");
    writeFileSync(resultsPath, JSON.stringify(results));
    const output = join(dir, "output.txt");
    writeFileSync(output, "");
    const reportDir = join(dir, "report");
    const result = boundedSpawnSync([process.execPath, SCRIPT], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GITHUB_OUTPUT: output,
        RESULTS: resultsPath,
        REPORT_DIR: reportDir,
      },
    });
    return { ...result, reportDir, output: readFileSync(output, "utf-8") };
  };

  test("findings: one report.md per target, the counts logged, findings and report-dir published", () => {
    const result = run(RESULTS);
    expect(result.exitCode).toBe(0);
    expect(readdirSync(result.reportDir).sort()).toEqual([
      "Dockerfile",
      "actions_pages-site_bun.lock",
      "tests_fixtures_keys.env",
      "trivy.json",
    ]);
    // The full results ride the artifact: rows past the report cap are not lost.
    expect(JSON.parse(readFileSync(join(result.reportDir, "trivy.json"), "utf-8"))).toEqual(
      RESULTS,
    );
    expect(readFileSync(join(result.reportDir, "Dockerfile", "report.md"), "utf-8")).toStartWith(
      "# Dockerfile: 2 findings\n",
    );
    expect(result.output).toBe(`findings=6\nfound=true\nreport-dir=${result.reportDir}\n`);
    expect(result.stdout).toContain(
      "trivy found 6 finding(s) in 3 target(s): 2 CRITICAL, 1 HIGH, 1 MEDIUM, 1 LOW, 1 UNKNOWN",
    );
    expect(result.stdout).toContain("  Dockerfile: 1 HIGH, 1 LOW");
  });

  test("a clean scan: an empty report directory and findings=0", () => {
    const result = run({ Results: [{ Target: "bun.lock", Class: "lang-pkgs", Type: "bun" }] });
    expect(result.exitCode).toBe(0);
    expect(existsSync(result.reportDir)).toBe(true);
    expect(readdirSync(result.reportDir)).toEqual([]);
    expect(result.output).toBe(`findings=0\nfound=false\nreport-dir=${result.reportDir}\n`);
    expect(result.stdout).toContain("trivy found nothing");
  });
});
