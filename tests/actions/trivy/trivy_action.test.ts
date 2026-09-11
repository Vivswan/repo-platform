// The trivy action's contract. A loosened flag is a deliberate edit here.
// The nightly inputs are pinned to report.ts's constants: the replay command must see what the scan saw.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SCAN_SEVERITY, SCANNERS } from "../../../actions/trivy/report";

const ACTION_YML = join(import.meta.dir, "../../../actions/trivy/action.yml");

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  shell?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

describe("the trivy action", () => {
  const action = parseYaml(readFileSync(ACTION_YML, "utf8"));
  const steps: Step[] = action.runs.steps;
  const byId = (id: string) => steps.find((step) => step.id === id);
  const scans = steps.filter((step) => (step.uses ?? "").startsWith("aquasecurity/trivy-action@"));

  test("blocking is the default mode; the outputs come from the nightly steps", () => {
    expect(action.inputs).toEqual({ mode: expect.objectContaining({ default: "blocking" }) });
    expect(action.outputs).toEqual({
      "findings": expect.objectContaining({ value: "${{ steps.report.outputs.findings }}" }),
      "found": expect.objectContaining({ value: "${{ steps.report.outputs.found }}" }),
      "report-dir": expect.objectContaining({ value: "${{ steps.report.outputs.report-dir }}" }),
      "sarif": expect.objectContaining({ value: "${{ steps.sarif.outputs.path }}" }),
    });
  });

  test("the bypass check runs unconditionally, after the action's own bun and before every scan", () => {
    const bunSetup = steps.findIndex((step) =>
      (step.uses ?? "").includes("repo-platform/actions/bun-setup@build"),
    );
    const bypass = steps.findIndex((step) => step.id === "bypass");
    expect(bunSetup).toBe(0);
    expect(bypass).toBe(1);
    expect(byId("bypass")?.if).toBeUndefined();
    expect(byId("bypass")?.run).toContain("/ignore_check.ts");
    for (const scan of scans) expect(steps.indexOf(scan)).toBeGreaterThan(bypass);
  });

  test("both scans ride one sha-pinned wrapper, one Trivy version, and the checked bypass file", () => {
    expect(scans).toHaveLength(2);
    const refs = new Set(scans.map((scan) => scan.uses));
    expect(refs.size).toBe(1);
    expect([...refs][0]).toMatch(/^aquasecurity\/trivy-action@[0-9a-f]{40}$/);
    for (const scan of scans) {
      expect(scan.with?.version).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(scan.with?.["scan-type"]).toBe("fs");
      expect(scan.with?.["scan-ref"]).toBe(".");
      expect(scan.with?.trivyignores).toBe("${{ steps.bypass.outputs.ignorefile }}");
      // Outside the workspace: the scan must never walk its own database.
      expect(scan.with?.["cache-dir"]).toBe("${{ runner.temp }}/trivy-cache");
    }
    expect(new Set(scans.map((scan) => scan.with?.version)).size).toBe(1);
  });

  test("the blocking scan fails on a fixable HIGH or CRITICAL finding and nothing else", () => {
    const [blocking] = scans;
    expect(blocking.if).toBe("inputs.mode == 'blocking'");
    expect(blocking.with).toEqual(
      expect.objectContaining({
        "scanners": "vuln,misconfig",
        "severity": "HIGH,CRITICAL",
        "ignore-unfixed": "true",
        "exit-code": "1",
      }),
    );
    expect(blocking.with?.format).toBeUndefined();
  });

  test("the nightly scan reports HIGH and CRITICAL as JSON without failing, then the report and SARIF steps read it", () => {
    const [, nightly] = scans;
    expect(nightly.if).toBe("inputs.mode == 'nightly'");
    expect(nightly.with).toEqual(
      expect.objectContaining({
        scanners: SCANNERS,
        severity: SCAN_SEVERITY,
        format: "json",
        output: "${{ runner.temp }}/trivy.json",
      }),
    );
    for (const key of ["ignore-unfixed", "exit-code"]) {
      expect(nightly.with?.[key]).toBeUndefined();
    }
    const report = byId("report");
    expect(report?.if).toBe("inputs.mode == 'nightly'");
    expect(report?.run).toContain("/report.ts");
    expect(report?.env).toEqual({
      ACTION_BUN: "${{ steps.action-bun.outputs.path }}",
      RESULTS: "${{ runner.temp }}/trivy.json",
      REPORT_DIR: "${{ runner.temp }}/trivy-report",
    });
    const sarif = byId("sarif");
    expect(sarif?.if).toBe("inputs.mode == 'nightly'");
    expect(sarif?.run).toContain('trivy convert --format sarif --output "$SARIF" "$RESULTS"');
    expect(sarif?.env).toEqual({
      RESULTS: "${{ runner.temp }}/trivy.json",
      SARIF: "${{ runner.temp }}/trivy.sarif",
    });
  });

  test("every run step is bash and every bun step runs the action's own bun by path", () => {
    for (const step of steps.filter((step) => step.run !== undefined)) {
      expect([step.id, step.shell]).toEqual([step.id, "bash"]);
      expect(step.if === undefined || step.if.startsWith("inputs.mode ==")).toBe(true);
      if (step.run?.includes(".ts")) expect(step.run).toStartWith('"$ACTION_BUN" ');
    }
  });
});
