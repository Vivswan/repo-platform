// actionlint does not read action.yml. action_references proves every step reference names an earlier step and a
// written key; that the bypass runs before every scan and unconditionally, and which knobs each scan carries, is
// checked here alone.

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
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

describe("the trivy action", () => {
  const action = parseYaml(readFileSync(ACTION_YML, "utf8"));
  const steps: Step[] = action.runs.steps;
  const byId = (id: string) => steps.find((step) => step.id === id);
  const scans = steps.filter((step) => (step.uses ?? "").startsWith("aquasecurity/trivy-action@"));

  test("the bypass check runs unconditionally, after the action's own bun and before every scan", () => {
    // The scans read `steps.bypass.outputs.ignorefile`: gated or moved below a scan, the bypass file goes unchecked.
    const bunSetup = steps.findIndex((step) => (step.uses ?? "").includes("/actions/bun-setup@"));
    const bypass = steps.findIndex((step) => step.id === "bypass");
    expect([bunSetup, bypass, byId("bypass")?.if]).toEqual([0, 1, undefined]);
    for (const scan of scans) expect(steps.indexOf(scan)).toBeGreaterThan(bypass);
  });

  test("both scans ride one sha-pinned wrapper, one Trivy version, and the checked bypass file", () => {
    // Dependabot bumps the two `uses` lines together; the two `version:` literals are hand-edited, so a half bump runs
    // the blocking scan on one Trivy and the nightly on another, green. The cache outside the workspace keeps the scan
    // from walking its own database.
    expect(scans).toHaveLength(2);
    expect(
      new Set(
        scans.map((scan) =>
          JSON.stringify([
            scan.uses,
            scan.with?.version,
            scan.with?.trivyignores,
            scan.with?.["cache-dir"],
          ]),
        ),
      ).size,
    ).toBe(1);
    expect(scans[0].uses).toMatch(/^aquasecurity\/trivy-action@[0-9a-f]{40}$/);
    expect(scans[0].with?.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(scans[0].with?.trivyignores).toBe("${{ steps.bypass.outputs.ignorefile }}");
    expect(scans[0].with?.["cache-dir"]).toBe("${{ runner.temp }}/trivy-cache");
  });

  test("the two modes: the blocking scan alone fails and ignores unfixed; the nightly scans what the replay command says and hands one results file to the report and SARIF steps", () => {
    // trivy-action's default exit code is 0, so without `exit-code: "1"` the blocking scan never fails, green. The
    // nightly's scanners and severity are report.ts's constants: the replay command must see what the scan saw. The
    // outputs map hands the caller the keys report.ts writes; a mistyped mapping reads empty, so fleet-nightly's
    // `found == 'true'` gates upload and file nothing and its `== 'false'` gate closes nothing: a red night is never
    // recorded, green.
    const [blocking, nightly] = scans;
    // fleet-ci calls the action with no `mode`: without the blocking default an empty mode gates both scans false and
    // the security job passes without scanning.
    expect([action.inputs.mode.default, blocking.if, nightly.if]).toEqual([
      "blocking",
      "inputs.mode == 'blocking'",
      "inputs.mode == 'nightly'",
    ]);
    const knobs = (scan: Step) => [
      scan.with?.["exit-code"],
      scan.with?.["ignore-unfixed"],
      scan.with?.scanners,
      scan.with?.severity,
      scan.with?.format,
    ];
    expect(knobs(blocking)).toEqual(["1", "true", "vuln,misconfig", "HIGH,CRITICAL", undefined]);
    expect(knobs(nightly)).toEqual([undefined, undefined, SCANNERS, SCAN_SEVERITY, "json"]);
    const results = nightly.with?.output;
    expect(results).toBe("${{ runner.temp }}/trivy.json");
    expect([byId("report")?.env?.RESULTS, byId("sarif")?.env?.RESULTS]).toEqual([results, results]);
    expect(byId("sarif")?.run).toContain('echo "path=$SARIF" >> "$GITHUB_OUTPUT"');
    const written = String(byId("report")?.run);
    expect(written).toContain("/report.ts");
    expect(
      Object.fromEntries(
        Object.entries(action.outputs).map(([k, v]) => [k, (v as { value: string }).value]),
      ),
    ).toEqual({
      findings: "${{ steps.report.outputs.findings }}",
      found: "${{ steps.report.outputs.found }}",
      "report-dir": "${{ steps.report.outputs.report-dir }}",
      sarif: "${{ steps.sarif.outputs.path }}",
    });
  });
});
