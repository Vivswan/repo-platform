// The single-call fleet CI's shape contract: fleet-ci.yml is the fleet's
// gate-job home, so the properties every managed repository used to prove
// per render are pinned here once (this suite absorbed the retired
// per-render validate-template/yamllint job-shape suite - the reporting
// bash itself lives in the validate-template-report action, pinned by
// tests/actions/validate_template_report.test.ts). The validate-template
// and yamllint jobs are THIN callers of their @build actions (the
// predicates live in the actions and are their suites' job to police);
// module- and visibility-conditioned jobs carry job-level guards (a
// skipped job stands down in the all-green verdict); and no job may sleep
// - the gate waits by failing fast, never on a billed runner.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface Step {
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  with?: Record<string, string>;
}
interface Job {
  if?: string;
  uses?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
  strategy?: { matrix?: Record<string, string> };
  with?: Record<string, string>;
}

const source = readFileSync(join(import.meta.dir, "../../.github/workflows/fleet-ci.yml"), "utf8");
const fleetCi = parseYaml(source) as { jobs: Record<string, Job> };

describe("fleet-ci.yml", () => {
  test("validate-template is a thin caller of the report action at @build", () => {
    const job = fleetCi.jobs["validate-template"];
    const steps = job?.steps ?? [];
    const uses = steps.map((step) => step.uses ?? "run");
    expect(uses).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("repo-platform/actions/validate-template-report@build"),
      "run",
    ]);
    // The action needs the token for the freshness read and the sticky
    // comment; the operator default (template-repo) is already this repo.
    expect(steps[1]?.id).toBe("template");
    expect(steps[1]?.with?.["github-token"]).toBe("${{ secrets.GITHUB_TOKEN }}");
    // The report action DEFERS the integrity verdict; the LAST step
    // re-raises it fail-closed, hence '!=': an output that resolved EMPTY
    // (a broken or renamed mapping inside the action) still re-raises -
    // only a literal success opens the gate. Last, so the sticky findings
    // comment is already posted when the gate goes red.
    const last = steps[steps.length - 1];
    expect(last?.if).toBe("steps.template.outputs.integrity != 'success'");
    expect(last?.run).toContain("exit 1");
    // Only for the sticky findings comment, and only on this job.
    expect(job?.permissions).toEqual({ "contents": "read", "pull-requests": "write" });
  });

  test("yamllint is a thin caller of the yamllint action at @build", () => {
    // The merged (private) shape's yamllint step is pinned by the TOOLS loop
    // below; this pins the fan-out job's EXACT two-step shape.
    const fanout = (fleetCi.jobs.yamllint?.steps ?? []).map((step) => step.uses ?? "");
    expect(fanout).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("repo-platform/actions/yamllint@build"),
    ]);
  });

  test("the private/public base-check shapes are complementary job-level guards", () => {
    expect(fleetCi.jobs["base-checks"]?.if).toBe("inputs.private");
    for (const job of ["typography", "commit-names", "actionlint", "yamllint", "gitleaks"]) {
      expect(fleetCi.jobs[job]?.if).toBe("${{ !inputs.private }}");
    }
    // Every merged check step keeps running when an earlier one fails.
    const guarded = (fleetCi.jobs["base-checks"]?.steps ?? []).slice(1);
    expect(guarded.length).toBeGreaterThanOrEqual(5);
    for (const step of guarded) expect(step.if).toBe("!cancelled()");
  });

  test("every base check's tool step survives in BOTH billing shapes", () => {
    // The check is its action; losing a step from either shape would drop
    // the check for one visibility with nothing else noticing (the retired
    // per-render assertions covered this per repo).
    const TOOLS = {
      "typography": "repo-platform/actions/check-typography@build",
      "commit-names": "repo-platform/actions/validate-commit-names@build",
      "actionlint": "raven-actions/actionlint@",
      "yamllint": "repo-platform/actions/yamllint@build",
      "gitleaks": "gitleaks/gitleaks-action@",
    };
    const merged = (fleetCi.jobs["base-checks"]?.steps ?? []).map((step) => step.uses ?? "");
    for (const [job, tool] of Object.entries(TOOLS)) {
      expect(merged).toContainEqual(expect.stringContaining(tool));
      const fanout = (fleetCi.jobs[job]?.steps ?? []).map((step) => step.uses ?? "");
      expect(fanout).toContainEqual(expect.stringContaining(tool));
    }
  });

  test("dependency-review is public-PR-only and calls the wrapper at @build", () => {
    const job = fleetCi.jobs["dependency-review"];
    expect(job?.if).toBe("${{ !inputs.private && github.event_name == 'pull_request' }}");
    expect((job?.steps ?? []).map((step) => step.uses ?? "")).toContainEqual(
      expect.stringContaining("repo-platform/actions/dependency-review@build"),
    );
  });

  test("each module job is armed by ITS OWN module (a swapped guard would arm the wrong gate)", () => {
    const GUARDS = {
      "validate-skills": "contains(fromJSON(inputs.modules), 'skills')",
      "release-freshness":
        "contains(fromJSON(inputs.modules), 'release-please') && github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')",
      "release-health":
        "contains(fromJSON(inputs.modules), 'release-please') && github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')",
    };
    for (const [job, guard] of Object.entries(GUARDS)) {
      expect(fleetCi.jobs[job]?.if).toBe(guard);
    }
  });

  test("validate-skills calls its action at @build with the skills-dir input forwarded", () => {
    const steps = fleetCi.jobs["validate-skills"]?.steps ?? [];
    const action = steps.find((step) =>
      (step.uses ?? "").includes("repo-platform/actions/validate-skills@build"),
    );
    expect(action?.with?.["skills-dir"]).toBe("${{ inputs.skills-dir }}");
  });

  test("release-health calls its action at @build in pull-request mode, labels forwarded", () => {
    const steps = fleetCi.jobs["release-health"]?.steps ?? [];
    const action = steps.find((step) =>
      (step.uses ?? "").includes("repo-platform/actions/release-health@build"),
    );
    expect(action?.with?.mode).toBe("pull-request");
    expect(action?.with?.["tracking-labels"]).toBe("${{ inputs.tracking-labels }}");
  });

  test("codeql is a matrix over the codeql-languages input, skipped when empty", () => {
    const job = fleetCi.jobs.codeql;
    expect(job?.if).toContain("inputs.codeql-languages != '[]'");
    expect(job?.uses).toBe("./.github/workflows/reusable-codeql.yml");
    // The matrix and the forwarding are the wiring the test name claims:
    // either expression breaking would silently scan nothing.
    expect(job?.strategy?.matrix?.language).toBe("${{ fromJSON(inputs.codeql-languages) }}");
    expect(job?.with?.language).toBe("${{ matrix.language }}");
    expect(job?.permissions?.["security-events"]).toBe("write");
  });

  test("nothing sleeps: the gate waits by failing fast", () => {
    expect(source).not.toContain("sleep ");
  });

  test("no job is named all-green or info-* (the gate job owns the name; the info opt-out is retired)", () => {
    for (const name of Object.keys(fleetCi.jobs)) {
      expect(name).not.toBe("all-green");
      expect(name.startsWith("info-")).toBe(false);
    }
  });
});
