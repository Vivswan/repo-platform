// actionlint does not read action.yml. action_references proves every step reference names an earlier step and a
// written key; the knobs each scan carries that trivy-action and GitHub enforce nowhere are checked here alone.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SCAN_SEVERITY, SCANNERS } from "../../../actions/trivy/report";

const ACTION_YML = join(import.meta.dir, "../../../actions/trivy/action.yml");

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

describe("the trivy action", () => {
  const action = parseYaml(readFileSync(ACTION_YML, "utf8"));
  const steps: Step[] = action.runs.steps;
  const byId = (id: string) => steps.find((step) => step.id === id);
  const scans = steps.filter((step) => (step.uses ?? "").startsWith("aquasecurity/trivy-action@"));

  test("both scans ride one sha-pinned wrapper at one Trivy version", () => {
    // Dependabot bumps the two `uses` lines together; the two `version:` literals are hand-edited, so a half bump runs
    // the blocking scan on one Trivy and the nightly on another, green.
    expect(scans).toHaveLength(2);
    expect(new Set(scans.map((scan) => JSON.stringify([scan.uses, scan.with?.version]))).size).toBe(
      1,
    );
    expect(scans[0].uses).toMatch(/^aquasecurity\/trivy-action@[0-9a-f]{40}$/);
    expect(scans[0].with?.version).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  test("the blocking scan fails on findings, the nightly scans what the replay command says and hands one results file to the report and SARIF steps", () => {
    // trivy-action's default exit code is 0, so without `exit-code: "1"` the blocking scan never fails, green. The
    // nightly's scanners and severity are report.ts's constants: the replay command must see what the scan saw.
    const [blocking, nightly] = scans;
    // Cross-file with fleet-ci.yml: it calls the action with no `mode`, so without the blocking default an empty mode
    // gates both scans false and the security job passes without scanning.
    const caller = (
      parseYaml(
        readFileSync(join(import.meta.dir, "../../../.github/workflows/fleet-ci.yml"), "utf8"),
      ) as {
        jobs: Record<string, { steps?: Step[] }>;
      }
    ).jobs;
    const call = Object.values(caller)
      .flatMap((job) => job.steps ?? [])
      .find((step) => (step.uses ?? "").includes("/actions/trivy@"));
    expect([call !== undefined, call?.with?.mode, action.inputs.mode.default]).toEqual([
      true,
      undefined,
      "blocking",
    ]);
    expect(blocking.with?.["exit-code"]).toBe("1");
    // report.ts parses the results file as Trivy JSON, so the nightly must write that format.
    expect([nightly.with?.scanners, nightly.with?.severity, nightly.with?.format]).toEqual([
      SCANNERS,
      SCAN_SEVERITY,
      "json",
    ]);
    const results = nightly.with?.output;
    expect(results).toBeDefined();
    expect([byId("report")?.env?.RESULTS, byId("sarif")?.env?.RESULTS]).toEqual([results, results]);
    // Cross-file with fleet-nightly.yml: its `found == 'true'` gates upload and file, its `== 'false'` gate closes;
    // a mapping to another key reads a count there, so neither gate runs and a red night is never recorded.
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
