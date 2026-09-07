// The settings workflow rules' pure helpers (scripts/check/ssot/settings_workflow.ts).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  settingsIdentityMismatches,
  stepOutputGateMismatches,
  unsafeStepCondition,
} from "../../../scripts/check/ssot/settings_workflow.ts";

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
      - uses: ./actions/validate-template-report
        id: template
      - name: Fail on an integrity finding
        if: steps.template.outputs.integrity != 'success'
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
              got: "steps.template.outputs.integrity != 'success' (a step that did not run has an ABSENT output, which passes)",
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
