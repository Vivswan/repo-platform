// The settings workflow rules' pure helpers (scripts/check/ssot/settings_workflow.ts).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  hiddenStepNoticeMismatches,
  printsNoticeAtTopLevel,
  settingsIdentityMismatches,
  stepOutputGateMismatches,
  unsafeStepCondition,
} from "../../../scripts/check/ssot/settings_workflow.ts";

const SCRIPTS = join(import.meta.dir, "../../../.github/scripts");

describe("printsNoticeAtTopLevel", () => {
  test.each([
    {
      reason: "a notice as the main block's action",
      source: 'import { notice } from "./gha.ts";\nif (import.meta.main) {\n  notice("x");\n}\n',
      prints: true,
    },
    {
      reason: "a ::notice:: literal printed at module level",
      source: 'console.log("::notice::x");\n',
      prints: true,
    },
    {
      reason: "a notice only inside a helper the entry point may never reach",
      source:
        'function report() {\n  notice("x");\n}\nif (import.meta.main) {\n  process.exit(main());\n}\n',
      prints: false,
    },
    {
      reason: "a notice behind a top-level condition (the workflow's if: owns the condition)",
      source: 'if (skipped) {\n  notice("x");\n}\n',
      prints: false,
    },
    {
      reason: "a method named notice on some other object",
      source: 'logger.notice("x");\n',
      prints: false,
    },
    {
      reason: "a notice behind a short-circuit never runs",
      source: 'false && notice("x");\n',
      prints: false,
    },
    {
      reason: "a notice inside a closure that is never called",
      source: 'void (() => notice("x"));\n',
      prints: false,
    },
    {
      reason: "a bare ::notice:: string statement prints nothing",
      source: '"::notice::x";\n',
      prints: false,
    },
    {
      reason: "a console.log whose literal does not start with the notice command",
      source: 'console.log("done ::notice::x");\n',
      prints: false,
    },
    {
      reason: "a ::notice:: template literal with an interpolated tail",
      source: "console.log(`::notice::${text}`);\n",
      prints: true,
    },
  ])("$reason: prints=$prints", ({ source, prints }) => {
    expect(printsNoticeAtTopLevel(source)).toBe(prints);
  });

  test("the live scripts: the skip reporter prints, the failure-report script does not", () => {
    expect(
      printsNoticeAtTopLevel(
        readFileSync(join(SCRIPTS, "fleet/report_skipped_target.ts"), "utf-8"),
      ),
    ).toBe(true);
    expect(
      printsNoticeAtTopLevel(readFileSync(join(SCRIPTS, "sync/failure_issue.ts"), "utf-8")),
    ).toBe(false);
  });
});

describe("hiddenStepNoticeMismatches", () => {
  const REL = "settings.yml";
  // A settings-shaped job: a wrapped render step (through a script that
  // builds the wrapper's path), a public skip notice (through a script whose
  // main block prints it), and a failure-report step whose script only
  // mentions notices inside helpers.
  const sources: Record<string, string> = {
    ".github/scripts/fleet/layer.ts":
      'const argv = ["bun", join(SCRIPTS, "sync", "run_hidden.ts"), label, "--"];\n',
    ".github/scripts/fleet/skip.ts": "if (import.meta.main) {\n  notice(text);\n}\n",
    ".github/scripts/sync/report.ts":
      'function assign() {\n  console.log("::notice::owner assignment skipped");\n}\nassign();\n',
  };
  const sourceOf = (rel: string) => {
    const source = sources[rel];
    if (source === undefined) throw new Error(`no synthetic source for ${rel}`);
    return source;
  };
  const jobs = (skipIf: string) => ({
    apply: {
      steps: [
        { id: "render", run: "bun .github/scripts/fleet/layer.ts render" },
        { name: "Report a skipped target", if: skipIf, run: "bun .github/scripts/fleet/skip.ts" },
        {
          name: "Resolve the settings failure report",
          if: "success() && steps.render.outputs.skipped == 'true'",
          run: "bun .github/scripts/sync/report.ts resolve",
        },
      ],
    },
  });

  test("the landed shape judges clean, counting the wrapped step (positive control)", () => {
    expect(
      hiddenStepNoticeMismatches(REL, jobs("steps.render.outputs.skipped == 'true'"), sourceOf),
    ).toEqual({ wrapped: 1, mismatches: [] });
  });

  test("dropping the render output from the skip notice fires: the report script's buried notices earn no credit", () => {
    expect(
      hiddenStepNoticeMismatches(REL, jobs("steps.merge.outputs.skipped == 'true'"), sourceOf),
    ).toEqual({
      wrapped: 1,
      mismatches: [
        {
          file: REL,
          expected: expect.stringContaining("AFTER the hidden 'render' step"),
          got: "no such step",
        },
      ],
    });
  });

  test("a wrapped step without an id fires", () => {
    expect(
      hiddenStepNoticeMismatches(
        REL,
        { apply: { steps: [{ run: 'bun .github/scripts/sync/run_hidden.ts "x" -- bun y.ts' }] } },
        sourceOf,
      ),
    ).toEqual({
      wrapped: 1,
      mismatches: [
        {
          file: REL,
          expected: `an id on the run_hidden-wrapped step "?" (job 'apply')`,
          got: "no id - a compensating notice cannot reference the step's outcome",
        },
      ],
    });
  });

  test("a notice step BEFORE the wrapped step does not compensate", () => {
    const before = jobs("steps.render.outputs.skipped == 'true'");
    before.apply.steps.reverse();
    expect(hiddenStepNoticeMismatches(REL, before, sourceOf)).toEqual({
      wrapped: 1,
      mismatches: [
        {
          file: REL,
          expected: expect.stringContaining("AFTER the hidden 'render' step"),
          got: "no such step",
        },
      ],
    });
  });
});

describe("settingsIdentityMismatches", () => {
  const identity = { description: "x", homepage: "", topics: "", private: false };

  test("passes when all four identity keys are declared, empty strings included", () => {
    expect(settingsIdentityMismatches(identity)).toEqual([]);
    expect(settingsIdentityMismatches({ ...identity, private: true, topics: "a, b" })).toEqual([]);
  });

  const { private: _noPrivate, ...withoutPrivate } = identity;
  const { description: _noDescription, ...withoutDescription } = identity;
  test.each([
    {
      reason: "a missing private key",
      repository: withoutPrivate,
      expected: {
        file: ".github/settings.yml repository.private",
        expected: "an explicit boolean, so the apply manages visibility",
        got: "missing",
      },
    },
    {
      reason: "a stringly-typed private key",
      repository: { ...identity, private: "false" },
      expected: {
        file: ".github/settings.yml repository.private",
        expected: "an explicit boolean, so the apply manages visibility",
        got: '"false"',
      },
    },
    {
      reason: "a missing description",
      repository: withoutDescription,
      expected: {
        file: ".github/settings.yml repository.description",
        expected: "a non-empty description string",
        got: "missing",
      },
    },
    {
      reason: "an empty description",
      repository: { ...identity, description: "" },
      expected: {
        file: ".github/settings.yml repository.description",
        expected: "a non-empty description string",
        got: '""',
      },
    },
  ])(
    "flags $reason as the one mismatch, naming the key and the value read",
    ({ repository, expected }) => {
      expect(settingsIdentityMismatches(repository)).toEqual([expected]);
    },
  );

  test("flags undeclared homepage and topics keys", () => {
    const mismatches = settingsIdentityMismatches({ description: "x", private: false });
    expect(mismatches.map((m) => m.file)).toEqual([
      ".github/settings.yml repository.homepage",
      ".github/settings.yml repository.topics",
    ]);
  });
});

describe("unsafeStepCondition", () => {
  // An absent output compares as the number 0, so only `== '<non-zero>'`
  // and `!= ''` are admitted; the rejected list below is not exhaustive.
  // Each row pins WHICH term the check names: a regression that flags the
  // safe first term of a compound and skips the unsafe one cannot pass.
  test.each([
    {
      condition: "steps.merge.outputs.skipped != 'true'",
      offending: "steps.merge.outputs.skipped != 'true'",
      reason: "an inequality",
    },
    {
      condition: "steps.render.outputs.skipped!='true'",
      offending: "steps.render.outputs.skipped!='true'",
      reason: "an unspaced inequality",
    },
    {
      condition: "'true' != steps.merge.outputs.skipped",
      offending: "'true' != steps.merge.outputs.skipped",
      reason: "a reversed inequality",
    },
    {
      condition: "!steps.merge.outputs.skipped",
      offending: "!steps.merge.outputs.skipped",
      reason: "a bare negation",
    },
    {
      condition: "! steps.merge.outputs.skipped",
      offending: "! steps.merge.outputs.skipped",
      reason: "a spaced negation",
    },
    {
      condition: "!(steps.merge.outputs.skipped == 'true')",
      offending: "a negated group: !(steps.merge.outputs.skipped == 'true')",
      reason: "a negated group around a safe equality",
    },
    {
      condition: "!(success() && steps.merge.outputs.skipped == 'true')",
      offending: "a negated group: !(success() && steps.merge.outputs.skipped == 'true')",
      reason: "a negated group around a compound",
    },
    // An absent output is null, which Actions compares as the number 0:
    // equal to '', to false, and to every spelling of zero.
    {
      condition: "steps.merge.outputs.skipped == ''",
      offending: "steps.merge.outputs.skipped == ''",
      reason: "equality against the empty string",
    },
    {
      condition: "steps.links.outputs.broken == '0'",
      offending: "steps.links.outputs.broken == '0'",
      reason: "equality against zero",
    },
    {
      condition: "steps.links.outputs.broken == '0.0'",
      offending: "steps.links.outputs.broken == '0.0'",
      reason: "equality against a spelling of zero",
    },
    {
      condition: "steps.merge.outputs.skipped == false",
      offending: "steps.merge.outputs.skipped == false",
      reason: "equality against false",
    },
    {
      condition: "steps.a.outputs.b == 'false' && steps.c.outputs.d != 'true'",
      offending: "steps.c.outputs.d != 'true'",
      reason: "an unsafe second && operand behind a safe first one",
    },
    {
      condition: "steps.a.outputs.b == 'false' || !steps.c.outputs.d",
      offending: "!steps.c.outputs.d",
      reason: "an unsafe second || operand behind a safe first one",
    },
  ])("rejects $reason, naming the offending term: $condition", ({ condition, offending }) => {
    expect(unsafeStepCondition(condition)).toBe(offending);
  });

  const safe = [
    "steps.merge.outputs.skipped == 'false'",
    "steps.render.outputs.skipped == 'false' && steps.merge.outputs.skipped == 'false'",
    "success() && (steps.apply.outcome == 'success' || steps.render.outputs.skipped == 'true')",
    // always() is not itself the hazard: an absent output still fails the
    // equality, so a reporting step may use it.
    "always() && steps.merge.outputs.skipped == 'false'",
    "failure() && env.HIDE_DETAILS == 'true'",
    // Not a step output: a failed dependency blocks the job outright.
    "needs.select.outputs.targets != '[]'",
    "success() && env.TARGET != ''",
    // An absent output compares equal to '', so this inequality fails on it.
    "steps.refresh.outputs.bumps != ''",
    "",
  ];
  for (const condition of safe) {
    test(`accepts ${condition === "" ? "(no condition)" : condition}`, () => {
      expect(unsafeStepCondition(condition)).toBeNull();
    });
  }
});

describe("stepOutputGateMismatches (step-output-gates)", () => {
  const WORKFLOWS = ".github/workflows";
  const stepsOf = (yaml: string) => {
    const doc = parseYaml(yaml) as { jobs: Record<string, { steps?: Record<string, unknown>[] }> };
    return Object.values(doc.jobs).flatMap((job) => job.steps ?? []);
  };
  // A refresh-style workflow (not the settings workflow the rule once
  // scanned alone) whose push step is gated on a step output.
  const refresh = (condition: string) => `
on:
  schedule:
    - cron: "0 6 * * 1"
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - id: changes
        run: bun scripts/refresh.ts
      - name: Commit, push, and open PR
        if: ${condition}
        run: bun scripts/open_pr.ts
`;

  test("a planted negative gate in a non-settings workflow goes red, naming the step and the term", () => {
    expect(
      stepOutputGateMismatches(
        "refresh.yml",
        stepsOf(refresh("steps.changes.outputs.changed != 'true'")),
      ),
    ).toEqual([
      {
        file: "refresh.yml",
        expected: 'step "Commit, push, and open PR" tests step outputs positively',
        got: "steps.changes.outputs.changed != 'true' (a step that did not run has an ABSENT output, which passes)",
      },
    ]);
  });

  test("the same workflow gated positively is green (control)", () => {
    expect(
      stepOutputGateMismatches(
        "refresh.yml",
        stepsOf(refresh("steps.changes.outputs.changed == 'true'")),
      ),
    ).toEqual([]);
  });

  // fleet-ci's fail-closed re-raise: exempt only while the step provably
  // exits non-zero (bare `exit <n>` last line, no continue-on-error).
  const reraise = (run: string, extra = "") => `
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: ./actions/validate-managed-files
        id: validate
      - name: Fail on an integrity finding
        if: steps.validate.outputs.integrity != 'success'
        ${extra}
        run: ${JSON.stringify(run)}
`;
  test.each([
    { run: "echo '::error::integrity failed'\nexit 1\n", red: false, shape: "a fail step" },
    { run: "echo '::error::integrity failed'\nexit 2", red: false, shape: "a fail step exiting 2" },
    { run: "echo '::error::integrity failed'\nexit 0\n", red: true, shape: "a step exiting 0" },
    { run: "exit 1\necho done\n", red: true, shape: "a step that keeps running after exit 1" },
    { run: "true || exit 1", red: true, shape: "an exit 1 behind a short-circuit" },
    { run: "echo exit 1", red: true, shape: "an exit 1 that is only text" },
    { run: "bun scripts/publish.ts", red: true, shape: "a step with an effect" },
    {
      run: "exit 1",
      extra: "continue-on-error: true",
      red: true,
      shape: "a fail step whose failure is swallowed",
    },
  ])("a negative gate on $shape: red=$red", ({ run, extra, red }) => {
    expect(stepOutputGateMismatches("fleet-ci.yml", stepsOf(reraise(run, extra)))).toEqual(
      red
        ? [
            {
              file: "fleet-ci.yml",
              expected: 'step "Fail on an integrity finding" tests step outputs positively',
              got: "steps.validate.outputs.integrity != 'success' (a step that did not run has an ABSENT output, which passes)",
            },
          ]
        : [],
    );
  });

  test("every live workflow judges clean, and the scan reaches beyond settings-repos.yml (ARMED)", () => {
    const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
    expect(files.length).toBeGreaterThan(2);
    for (const name of files) {
      const rel = `${WORKFLOWS}/${name}`;
      expect(stepOutputGateMismatches(rel, stepsOf(readFileSync(rel, "utf-8")))).toEqual([]);
    }
  });
});
