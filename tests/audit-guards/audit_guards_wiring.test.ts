// Layer 2's existence pin: the binding check and the registry are held
// in CI by ssot's local-gates rule, but the weekly arming audit lives in
// a workflow nothing else references - deleting audit-guards.yml, gutting
// its audit command, or softening the report conditions would silently
// retire the only ARMING proof while every per-commit gate stayed green.
// This suite pins the wiring: triggers, the unsuppressed audit command,
// the report jobs' conditions, and the tracking label's parity with its
// .github/settings.yml declaration (an undeclared label enters the
// settings apply's delete/recreate loop).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dir, "../..");
const AUDIT_COMMAND = "bun .github/scripts/audit-guards/arm_audit.ts";

type Mapping = Record<string, unknown>;
function asMapping(value: unknown): Mapping {
  expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
  return value as Mapping;
}

const workflow = asMapping(
  parseYaml(readFileSync(join(root, ".github/workflows/audit-guards.yml"), "utf-8")),
);
const jobs = asMapping(workflow.jobs);
const settings = asMapping(parseYaml(readFileSync(join(root, ".github/settings.yml"), "utf-8")));

function steps(job: unknown): Mapping[] {
  const list = asMapping(job).steps;
  expect(Array.isArray(list)).toBe(true);
  return (list as unknown[]).map(asMapping);
}

describe("audit-guards wiring", () => {
  test("the trigger set is exactly one weekly cron (Monday 08:44 UTC) plus manual dispatch", () => {
    // Pinned to the value: a widened cadence or an added trigger (a push,
    // say) would each move the audit past its weekly arming-proof role.
    expect(workflow.on).toEqual({ schedule: [{ cron: "44 8 * * 1" }], workflow_dispatch: null });
  });

  test("the audit job runs the arming audit unconditionally and unsuppressed, under a 30-minute hang bound", () => {
    const audit = asMapping(jobs.audit);
    // A hung arming loop is killed at this bound and the report reads the
    // cancellation as red; pinned so a silent tightening or loosening is loud.
    expect(audit["timeout-minutes"]).toBe(30);
    // Job-level suppression skips or ignores the audit as silently as
    // step-level suppression would.
    expect("if" in audit).toBe(false);
    expect("continue-on-error" in audit).toBe(false);
    const auditSteps = steps(audit).filter(
      (step) => String(step.run ?? "").trim() === AUDIT_COMMAND,
    );
    expect(auditSteps).toHaveLength(1);
    // A condition or continue-on-error on the step would fail the audit
    // open: it would run sometimes, or run and be ignored.
    expect("if" in auditSteps[0]).toBe(false);
    expect("continue-on-error" in auditSteps[0]).toBe(false);
  });

  test("the report job judges every audit outcome: red files (failure OR cancelled), green resolves", () => {
    const report = asMapping(jobs.report);
    expect(report.needs).toEqual(["audit"]);
    expect(String(report.if).trim()).toBe("always()");
    expect("continue-on-error" in report).toBe(false);
    expect(asMapping(report.permissions).issues).toBe("write");
    const issueSteps = steps(report).filter(
      (step) => String(step.uses ?? "") === "./actions/fuzz-issue",
    );
    expect(issueSteps).toHaveLength(2);
    const fileStep = issueSteps.find((step) => asMapping(step.with).mode === "report");
    const closeStep = issueSteps.find((step) => asMapping(step.with).mode === "resolve");
    expect(fileStep).toBeDefined();
    expect(closeStep).toBeDefined();
    // Exact conditions, not containment: a containment check would stay
    // green on `failure && cancelled`, a contradiction that never files.
    // A cancelled audit (a hang killed at the job timeout) is a finding,
    // not a green.
    expect(String(fileStep?.if).trim()).toBe(
      "needs.audit.result == 'failure' || needs.audit.result == 'cancelled'",
    );
    expect(String(closeStep?.if).trim()).toBe("needs.audit.result == 'success'");
  });

  test("the tracking label matches its .github/settings.yml declaration", () => {
    const report = asMapping(jobs.report);
    const issueSteps = steps(report).filter(
      (step) => String(step.uses ?? "") === "./actions/fuzz-issue",
    );
    const labels = issueSteps.map((step) => String(asMapping(step.with).label));
    expect(new Set(labels).size).toBe(1);
    const declared = (settings.labels as Mapping[]).find((label) => label.name === labels[0]);
    expect(declared).toBeDefined();
    const fileStep = issueSteps.find((step) => asMapping(step.with).mode === "report");
    const fileWith = asMapping(fileStep?.with);
    expect(String(declared?.color)).toBe(String(fileWith["label-color"]));
    expect(String(declared?.description)).toBe(String(fileWith["label-description"]));
  });
});
