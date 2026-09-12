import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface Step {
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  needs?: string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
}

const source = readFileSync(
  join(import.meta.dir, "../../.github/workflows/fleet-nightly.yml"),
  "utf8",
);
const fleetNightly = parseYaml(source) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

describe("fleet-nightly.yml", () => {
  test("is a workflow_call with no inputs, read-only at the top", () => {
    expect(Object.keys(fleetNightly.on)).toEqual(["workflow_call"]);
    expect(fleetNightly.on.workflow_call ?? null).toBeNull();
    expect(fleetNightly.permissions).toEqual({ contents: "read" });
  });

  test("plan is the first job, fleet-ci's twin: the sparse registration checkout, then the plan action at @stable", () => {
    const [first, second, ...rest] = Object.keys(fleetNightly.jobs);
    expect([first, second, rest]).toEqual(["plan", "trivy-nightly", []]);
    const job = fleetNightly.jobs.plan;
    expect(job?.if).toBeUndefined();
    const steps = job?.steps ?? [];
    expect(steps.map((step) => step.uses ?? "run")).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("repo-platform/actions/plan@stable"),
    ]);
    expect(steps[0]?.with).toEqual({
      "sparse-checkout": ".repo-platform.yml\n",
      "sparse-checkout-cone-mode": false,
    });
    expect(steps[1]?.id).toBe("plan");
    expect(steps[1]?.with).toEqual({ private: "${{ github.event.repository.private }}" });
    expect(steps[1]?.env).toEqual({ GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" });
    expect(job?.outputs).toEqual({ private: "${{ steps.plan.outputs.private }}" });
  });

  test("no job carries a condition (the skeleton's caller is the schedule gate) and none reads an input", () => {
    for (const [name, job] of Object.entries(fleetNightly.jobs)) {
      expect([name, job.if]).toEqual([name, undefined]);
    }
    expect(source.slice(source.indexOf("\njobs:"))).not.toContain("inputs.");
  });

  test("trivy-nightly needs plan, files or closes the security-nightly issue, and uploads SARIF for public repositories", () => {
    const job = fleetNightly.jobs["trivy-nightly"];
    expect(job?.needs).toEqual(["plan"]);
    // Exactly the skeleton's nightly caller grant: the reason this
    // workflow exists apart from fleet-ci.yml.
    expect(job?.permissions).toEqual({
      "contents": "read",
      "issues": "write",
      "security-events": "write",
    });
    const steps = job?.steps ?? [];
    expect(steps.map((step) => step.uses ?? "run")).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("repo-platform/actions/trivy@stable"),
      expect.stringContaining("actions/upload-artifact@"),
      expect.stringContaining("repo-platform/actions/fuzz-issue@stable"),
      expect.stringContaining("repo-platform/actions/fuzz-issue@stable"),
      expect.stringContaining("github/codeql-action/upload-sarif@"),
    ]);
    const [, scan, artifact, report, resolve, sarif] = steps;
    expect(scan.id).toBe("scan");
    expect(scan.with).toEqual({ mode: "nightly" });
    // Findings and the report ride the scan's outputs: found is the exact
    // literal either way, so an absent output fires neither step.
    expect(artifact.if).toBe("steps.scan.outputs.found == 'true'");
    expect(artifact.with?.path).toBe("${{ steps.scan.outputs.report-dir }}");
    expect(report.if).toBe("steps.scan.outputs.found == 'true'");
    expect(report.with).toEqual({
      "mode": "report",
      "label": "security-nightly",
      "title": "Nightly security scan findings",
      "artifacts-dir": "${{ steps.scan.outputs.report-dir }}",
      "artifact-name": String(artifact.with?.name),
      "label-color": "1d76db",
      "label-description": "Automated nightly security scan findings",
      "stream": "generic",
    });
    expect(resolve.if).toBe("steps.scan.outputs.found == 'false'");
    expect(resolve.with).toEqual({ mode: "resolve", label: "security-nightly", stream: "generic" });
    // Personal-account code scanning is public-only: the exact literal
    // 'false', so an empty visibility output uploads nothing.
    expect(sarif.if).toBe("needs.plan.outputs.private == 'false'");
    expect(sarif.with).toEqual({
      sarif_file: "${{ steps.scan.outputs.sarif }}",
      category: "trivy",
    });
  });

  test("nothing sleeps, and no job is named all-green", () => {
    expect(source).not.toContain("sleep ");
    for (const name of Object.keys(fleetNightly.jobs)) expect(name).not.toBe("all-green");
  });
});
