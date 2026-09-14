// The Trivy JSON field names are external, and a matched secret in an issue body is the one silent security failure
// here. The report shape is a contract with fuzz-issue: only the first 60 lines survive into the issue when an artifact
// exists (docs/fuzzer.md), so a replay block below the rows would vanish, and a directory named outside fuzz-issue's
// DIR_NAME is dropped without a word.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectFindings,
  directoryName,
  MAX_NAME,
  MAX_ROWS,
  RESULTS_NAME,
  reportBody,
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
    expect([{}, null, { Results: [{ Target: "bun.lock" }] }].map(collectFindings)).toEqual([
      [],
      [],
      [],
    ]);
  });
});

describe("reportBody", () => {
  test("a contract-v1 report: the heading names the target, the replay block comes first, then one row per finding; a spaced target is one shell word", () => {
    const body = reportBody(collectFindings(RESULTS)[1]);
    expect(body.split("\n")).toEqual([
      "# Dockerfile: 2 findings",
      "",
      "Nightly Trivy scan, 1 HIGH, 1 LOW. Replay from the repository root:",
      "",
      "```",
      "trivy fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --ignorefile .trivyignore.yaml Dockerfile",
      "```",
      "",
      "- HIGH DS-0002: Image user should not be 'root'. Add 'USER <non root user name>' line to the Dockerfile https://avd.aquasec.com/misconfig/ds-0002",
      "- LOW DS-0026 line 1: No HEALTHCHECK defined. Add HEALTHCHECK instruction in your Dockerfile https://avd.aquasec.com/misconfig/ds-0026",
      "",
    ]);
    // A wrong quoting is a replay command that fails on the operator's machine.
    expect(
      reportBody({ target: "it's/my app/bun.lock", findings: [{ severity: "LOW", line: "x" }] }),
    ).toContain(
      "\ntrivy fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --ignorefile .trivyignore.yaml 'it'\\''s/my app/bun.lock'\n",
    );
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
});

describe("directoryName", () => {
  test("a target path becomes a contract-conforming name, unique within the run; past the name limit its head plus a hash of the whole", () => {
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
    const deep = `${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(100)}/package-lock.json`;
    const name = directoryName(deep, new Set());
    expect(name).toHaveLength(MAX_NAME);
    expect(name).toMatch(/^a{91}-[0-9a-f]{8}$/);
    expect(directoryName(`${deep}x`, new Set())).not.toBe(name);
  });
});

// The executed entry point: the output keys are action.yml's outputs map, and `found=false` is the literal
// fleet-nightly's `== 'false'` upload gate reads.
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

  test.each<{
    reason: string;
    results: unknown;
    listing: string[];
    outputs: string;
    says: string[];
  }>([
    {
      reason:
        "findings: one report.md per target, the counts logged, findings and report-dir published",
      results: RESULTS,
      listing: [
        "Dockerfile",
        "actions_pages-site_bun.lock",
        "tests_fixtures_keys.env",
        "trivy.json",
      ],
      outputs: "findings=6\nfound=true\n",
      says: [
        "trivy found 6 finding(s) in 3 target(s): 2 CRITICAL, 1 HIGH, 1 MEDIUM, 1 LOW, 1 UNKNOWN",
        "  Dockerfile: 1 HIGH, 1 LOW",
      ],
    },
    {
      reason: "a clean scan: an empty report directory and findings=0",
      results: { Results: [{ Target: "bun.lock", Class: "lang-pkgs", Type: "bun" }] },
      listing: [],
      outputs: "findings=0\nfound=false\n",
      says: ["trivy found nothing"],
    },
    {
      reason:
        "a target named like the full-results file gets the allocator's suffix instead of colliding",
      results: {
        Results: [
          {
            Target: RESULTS_NAME,
            Class: "secret",
            Secrets: [
              { RuleID: "github-pat", Severity: "CRITICAL", Title: "GitHub PAT", StartLine: 1 },
            ],
          },
        ],
      },
      listing: [RESULTS_NAME, `${RESULTS_NAME}-2`],
      outputs: "findings=1\nfound=true\n",
      says: ["trivy found 1 finding(s) in 1 target(s): 1 CRITICAL"],
    },
  ])("$reason", ({ results, listing, outputs, says }) => {
    const result = run(results);
    expect([result.exitCode, readdirSync(result.reportDir).sort(), result.output]).toEqual([
      0,
      listing,
      `${outputs}report-dir=${result.reportDir}\n`,
    ]);
    expect(says.filter((line) => result.stdout.includes(line))).toEqual(says);
    if (listing.length > 0) {
      // The full results ride the artifact: rows past the report cap are not lost.
      expect(JSON.parse(readFileSync(join(result.reportDir, RESULTS_NAME), "utf-8"))).toEqual(
        results,
      );
      // Each report.md is the body the issue shows; an empty or wrong body ships a listing with no findings text.
      const taken = new Set([RESULTS_NAME]);
      const bodies = Object.fromEntries(
        collectFindings(results).map((report) => [
          directoryName(report.target, taken),
          reportBody(report),
        ]),
      );
      expect(
        Object.fromEntries(
          listing
            .filter((entry) => entry !== RESULTS_NAME)
            .map((name) => [
              name,
              readFileSync(join(result.reportDir, name, "report.md"), "utf-8"),
            ]),
        ),
      ).toEqual(bodies);
    }
  });
});
