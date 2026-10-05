// The two facts the trivy action's manifest shares with another file and neither can see: fleet-ci.yml calls it with
// no mode, so the blocking default is what the fleet's security job runs; the nightly scan's scanners and severity
// are report.ts's constants, so the replay command the report prints sees what the scan saw. And the directory
// fleet-ci.yml checks this repository out into, which trivy walks (its lockfiles are not the caller's to fix).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_CHECKOUT_DIR } from "../../../actions/shared/platform";
import { SCAN_SEVERITY, SCANNERS } from "../../../actions/trivy/report";

const ROOT = join(import.meta.dir, "../../..");
const read = (rel: string) => parseYaml(readFileSync(join(ROOT, rel), "utf8"));

interface Step {
  if?: string;
  uses?: string;
  with?: Record<string, string>;
}

const action = read("actions/trivy/action.yml") as {
  inputs: { mode: { default: string } };
  runs: { steps: Step[] };
};
const scans = action.runs.steps.filter((step) =>
  (step.uses ?? "").startsWith("aquasecurity/trivy-action@"),
);

// Without the blocking default an empty mode gates both scans false and the security job passes without scanning;
// trivy-action's own exit code defaults to 0, so without `exit-code: "1"` the scan it does run never fails.
test("fleet-ci.yml calls the action with no mode, and the one scan gated on the default mode fails on a finding", () => {
  const fleetCi = read(".github/workflows/fleet-ci.yml") as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const calls = Object.values(fleetCi.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.uses === `./${PLATFORM_CHECKOUT_DIR}/actions/trivy`);
  const defaultScans = scans.filter(
    (scan) => scan.if === `inputs.mode == '${action.inputs.mode.default}'`,
  );
  expect({
    callerModes: calls.map((call) => call.with?.mode),
    exitCodes: defaultScans.map((scan) => scan.with?.["exit-code"]),
  }).toEqual({ callerModes: [undefined], exitCodes: ["1"] });
});

test("the nightly scan's scanners and severity are the constants report.ts prints in its replay command", () => {
  const nightly = scans.filter((scan) => scan.if === "inputs.mode == 'nightly'");
  expect(nightly.map((scan) => [scan.with?.scanners, scan.with?.severity])).toEqual([
    [SCANNERS, SCAN_SEVERITY],
  ]);
});

test("both scans skip the platform checkout fleet-ci.yml makes beside the caller's files", () => {
  expect(scans.map((scan) => scan.with?.["skip-dirs"])).toEqual([
    PLATFORM_CHECKOUT_DIR,
    PLATFORM_CHECKOUT_DIR,
  ]);
});
