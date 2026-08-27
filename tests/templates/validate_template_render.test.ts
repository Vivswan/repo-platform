// The rendered validate-template job's SHAPE - the part that stayed in the
// workflow because a composite action cannot express it, and the part the
// action's own suite therefore cannot cover.
//
// This replaces the suite that executed the job's inline reporting bash.
// That bash lives in the validate-template-report action now (freshness.ts
// and report.ts, pinned by tests/actions/validate_template_report.test.ts),
// so what is left to check is that every fleet repository gets a job wired
// to reach it:
//
//   - the job exists under its stable name, sits inside all-green's needs,
//     and scopes pull-requests: write to itself (the sticky comment's only
//     consumer),
//   - it calls the action rather than doing the work, at @build - the
//     branch that only advances from a green repo-platform main,
//   - the verdict is deferred, not discarded: the job's LAST step re-raises
//     the action's integrity output, so the findings comment is already
//     posted when the gate goes red.
//
// The rendered yamllint caller rides along here: same conversion, same
// split (the pip install and the strict flag are the yamllint action's own
// suite's to police).
//
// Read from the committed goldens, which CI drift-checks against
// templates/, so this suite depends on nothing outside the repository.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const RENDERS = join(import.meta.dir, "../golden-renders");
const GOLDENS = ["minimal", "all-modules", "uv-no-release-please"];
const REPORT_ACTION = "repo-platform/actions/validate-template-report@build";
const YAMLLINT_ACTION = "repo-platform/actions/yamllint@build";

interface Step {
  uses?: string;
  id?: string;
  if?: string;
  with?: Record<string, string>;
  run?: string;
}
interface Job {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}

function ci(golden: string): { jobs: Record<string, Job> } {
  return parseYaml(readFileSync(join(RENDERS, golden, ".github/workflows/ci.yml"), "utf8"));
}

describe("the rendered validate-template job", () => {
  for (const golden of GOLDENS) {
    test(`${golden}: the job exists, inside all-green's needs, unconditional`, () => {
      const jobs = ci(golden).jobs;
      expect(jobs["validate-template"]).toBeDefined();
      expect(jobs["validate-template"]?.if).toBeUndefined();
      // Integrity is a real gate, so the job belongs in the gate.
      expect(jobs["all-green"]?.needs ?? []).toContain("validate-template");
    });

    test(`${golden}: it calls the report action at @build with the operator pinned`, () => {
      const steps = ci(golden).jobs["validate-template"]?.steps ?? [];
      expect(steps[0]?.uses).toStartWith("actions/checkout@");
      expect(steps[1]?.uses).toContain(REPORT_ACTION);
      expect(steps[1]?.id).toBe("template");
      expect(steps[1]?.with?.["template-repo"]).toBe("Vivswan/repo-platform");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
      expect(steps[1]?.with?.["github-token"]).toBe("${{ secrets.GITHUB_TOKEN }}");
    });

    test(`${golden}: the verdict is deferred, not discarded: the LAST step re-raises it`, () => {
      // Last, so the sticky comment the action posts is already on the PR
      // when the gate goes red.
      const steps = ci(golden).jobs["validate-template"]?.steps ?? [];
      const last = steps[steps.length - 1];
      expect(steps).toHaveLength(3);
      expect(last?.if).toBe("steps.template.outputs.integrity == 'failure'");
      expect(last?.run).toContain("exit 1");
    });

    test(`${golden}: the comment write is scoped to this one job`, () => {
      expect(ci(golden).jobs["validate-template"]?.permissions).toEqual({
        "contents": "read",
        "pull-requests": "write",
      });
    });
  }
});

describe("the rendered yamllint job", () => {
  for (const golden of GOLDENS) {
    test(`${golden}: a thin caller of the action at @build, with no work of its own`, () => {
      const jobs = ci(golden).jobs;
      const steps = jobs.yamllint?.steps ?? [];
      expect(jobs["all-green"]?.needs ?? []).toContain("yamllint");
      expect(steps.map((step) => step.uses ?? "")).toEqual([
        expect.stringContaining("actions/checkout@"),
        expect.stringContaining(YAMLLINT_ACTION),
      ]);
      expect(steps.some((step) => step.run !== undefined)).toBe(false);
    });
  }
});
