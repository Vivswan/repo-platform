// The settings workflow rules' pure helpers (scripts/check/ssot/settings_workflow.ts).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  OWN_OVERLAY,
  overlayMismatches,
  SETTINGS_ACTION_USES,
  SETTINGS_STARTERS,
  SETTINGS_WORKFLOW,
  settingsApplyInputMismatches,
  settingsIdentityMismatches,
  starterMismatches,
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
        file: ".github/settings.local.yml repository.private",
        expected: "an explicit boolean, so the apply manages visibility",
        got: "missing",
      },
    },
    {
      reason: "a stringly-typed private key",
      repository: { ...identity, private: "false" },
      expected: {
        file: ".github/settings.local.yml repository.private",
        expected: "an explicit boolean, so the apply manages visibility",
        got: '"false"',
      },
    },
    {
      reason: "a missing description",
      repository: withoutDescription,
      expected: {
        file: ".github/settings.local.yml repository.description",
        expected: "a non-empty description string",
        got: "missing",
      },
    },
    {
      reason: "an empty description",
      repository: { ...identity, description: "" },
      expected: {
        file: ".github/settings.local.yml repository.description",
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
      ".github/settings.local.yml repository.homepage",
      ".github/settings.local.yml repository.topics",
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
    "failure() && env.TARGET_PRIVATE == 'true'",
    // Not a step output: a failed dependency blocks the job outright.
    "needs.plan.outputs.count != '0'",
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

describe("settingsApplyInputMismatches (settings-apply-input)", () => {
  // A minimal well-wired apply job, mutated per red case below: the
  // negative controls proving the judgment fails through the path its
  // green run takes.
  const APPLY_WITH = [
    "          token: ${{ secrets.REPO_PLATFORM_TOKEN }}",
    "          mode: ${{ inputs.check_only && 'check' || 'apply' }}",
    "          repos: ${{ steps.select.outputs.repos }}",
    "          private-repos: redact",
    "          private-report: issue",
    "          on-missing-permission: fail",
  ].join("\n");
  const GATE = "        if: steps.select.outputs.repos != ''\n";
  const USES = `        uses: ${SETTINGS_ACTION_USES}\n`;
  const valid = `
jobs:
  apply:
    steps:
      - name: Select settings targets
        id: select
        run: bun .github/scripts/fleet/select_settings_repos.ts
      - name: Apply repository settings
${GATE}${USES}        with:
${APPLY_WITH}
`;
  const expectedWith =
    "the apply step's with: exactly " +
    '{"token":"${{ secrets.REPO_PLATFORM_TOKEN }}",' +
    "\"mode\":\"${{ inputs.check_only && 'check' || 'apply' }}\"," +
    '"repos":"${{ steps.select.outputs.repos }}","private-repos":"redact",' +
    '"private-report":"issue","on-missing-permission":"fail"}';

  test("the synthetic fixture is judged clean - the control for every red case below", () => {
    expect(settingsApplyInputMismatches(valid)).toEqual([]);
  });

  test.each([
    {
      reason: "a repository input beside repos (single-repo mode over a scratch document)",
      text: valid.replace(APPLY_WITH, `${APPLY_WITH}\n          repository: Vivswan/x`),
      expected: expectedWith,
    },
    {
      reason: "a settings-file input (a document other than each target's own)",
      text: valid.replace(APPLY_WITH, `${APPLY_WITH}\n          settings-file: merged.yml`),
      expected: expectedWith,
    },
    {
      reason: "a defaults-file input",
      text: valid.replace(APPLY_WITH, `${APPLY_WITH}\n          defaults-file: d.yml`),
      expected: expectedWith,
    },
    {
      reason: "a repos-dir input",
      text: valid.replace(APPLY_WITH, `${APPLY_WITH}\n          repos-dir: repos`),
      expected: expectedWith,
    },
    {
      reason: 'repos: "*" - the action would discover the fleet itself, adopted or not',
      text: valid.replace("repos: ${{ steps.select.outputs.repos }}", 'repos: "*"'),
      expected: expectedWith,
    },
    {
      reason: "repos read from a step other than the selector",
      text: valid.replace(
        "repos: ${{ steps.select.outputs.repos }}",
        "repos: ${{ steps.other.outputs.repos }}",
      ),
      expected: expectedWith,
    },
    {
      reason:
        "a dropped on-missing-permission (the action's default is fail, but the pin is explicit)",
      text: valid.replace("\n          on-missing-permission: fail", ""),
      expected: expectedWith,
    },
    {
      reason: "a mode that ignores check_only",
      text: valid.replace("mode: ${{ inputs.check_only && 'check' || 'apply' }}", "mode: apply"),
      expected: expectedWith,
    },
    {
      reason: "private-repos: show (a private slug in this public log)",
      text: valid.replace("private-repos: redact", "private-repos: show"),
      expected: expectedWith,
    },
    {
      reason: "an unpinned uses (a moving tag)",
      text: valid.replace(USES, "        uses: Vivswan/github-settings-as-code@v2\n"),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
    },
    {
      reason: "the pin without its version comment",
      text: valid.replace(" # v2.0.0", ""),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
    },
    {
      reason:
        "the uses value folded into a block scalar, beside a decoy scalar spelling the pinned line",
      text: valid
        .replace(USES, "        uses: >-\n          Vivswan/github-settings-as-code@v2\n")
        .replace("jobs:\n", `env:\n  DECOY: |\n    uses: ${SETTINGS_ACTION_USES}\njobs:\n`),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
    },
    {
      reason: "the uses value reached through a YAML alias (no pin on the step itself)",
      text: valid
        .replace(USES, "        uses: *settings_action\n")
        .replace(
          "jobs:\n",
          "env:\n  SETTINGS_ACTION: &settings_action Vivswan/github-settings-as-code@v2\njobs:\n",
        ),
      expected: `uses: ${SETTINGS_ACTION_USES} as a plain scalar on every apply step`,
    },
    {
      reason: "a stale version comment beside the right sha",
      text: valid.replace(" # v2.0.0", " # v1.9.0"),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
    },
    {
      reason: "an unpinned step beside a decoy carrying the expected line elsewhere in the file",
      text: valid
        .replace(USES, "        uses: Vivswan/github-settings-as-code@v2\n")
        .replace("jobs:\n", `env:\n  DECOY: "${SETTINGS_ACTION_USES}"\njobs:\n`),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
    },
    {
      reason: "no gate on the selector's output (an empty repos input is single-repo mode)",
      text: valid.replace(GATE, ""),
      expected: "the apply step gated on if: steps.select.outputs.repos != ''",
    },
    {
      reason:
        "a gate on the count (absent when the selector did not run, and not the value applied)",
      text: valid.replace(GATE, "        if: steps.select.outputs.count != '0'\n"),
      expected: "the apply step gated on if: steps.select.outputs.repos != ''",
    },
  ])("$reason is the one mismatch", ({ text, expected }) => {
    const got = settingsApplyInputMismatches(text);
    expect(got).toHaveLength(1);
    expect(got[0].file).toBe(SETTINGS_WORKFLOW);
    expect(got[0].expected).toBe(expected);
  });

  test("a second apply step is refused even when both are well-formed", () => {
    const second = valid.replace(
      "      - name: Apply repository settings",
      "      - name: Apply again\n" +
        GATE +
        USES +
        "        with:\n" +
        APPLY_WITH +
        "\n      - name: Apply repository settings",
    );
    expect(settingsApplyInputMismatches(second).map((m) => m.got)).toEqual(["2 steps"]);
  });

  test.each([
    {
      reason: "no github-settings-as-code step",
      text: valid.slice(0, valid.indexOf("      - name: Apply")),
    },
    {
      reason: "no selector step",
      text: valid.replace(
        "run: bun .github/scripts/fleet/select_settings_repos.ts",
        "run: echo bun .github/scripts/fleet/select_settings_repos.ts",
      ),
    },
  ])("$reason is anchor-lost, never a pass", ({ text }) => {
    expect(() => settingsApplyInputMismatches(text)).toThrow("anchor lost");
  });

  test("the live workflow is ARMED: it passes the rule's judgment", () => {
    expect(settingsApplyInputMismatches(readFileSync(SETTINGS_WORKFLOW, "utf-8"))).toEqual([]);
  });
});

describe("starterMismatches and overlayMismatches (settings-starter)", () => {
  const STARTER = [
    "repository:",
    '  description: "placeholder"',
    '  homepage: ""',
    '  topics: ""',
    "  private: false",
    "# labels:",
    "#   - name: example",
    "",
  ].join("\n");
  const REL = "files/base/.github/settings.local.yml";

  test("a starter seeding the four identity keys and nothing else is clean - the control", () => {
    expect(starterMismatches(REL, STARTER)).toEqual([]);
  });

  test.each([
    {
      reason: "a dropped identity key",
      text: STARTER.replace('  topics: ""\n', ""),
      mismatch: {
        file: REL,
        expected: "repository.topics seeded by the writer",
        got: "missing - the starter must declare all four identity keys",
      },
    },
    {
      reason: "a labels section (the commented example uncommented)",
      text: STARTER.replace("# labels:\n#   - name: example", "labels:\n  - name: example"),
      mismatch: {
        file: REL,
        expected:
          "no labels section (the fleet layers supply it; the starter only shows commented examples)",
        got: "declared",
      },
    },
    {
      reason: "a rulesets section",
      text: `${STARTER}rulesets: []\n`,
      mismatch: {
        file: REL,
        expected:
          "no rulesets section (the fleet layers supply it; the starter only shows commented examples)",
        got: "declared",
      },
    },
  ])("$reason is the one mismatch", ({ text, mismatch }) => {
    expect(starterMismatches(REL, text)).toEqual([mismatch]);
  });

  test("the live starters are ARMED: both pass the judgment", () => {
    for (const rel of SETTINGS_STARTERS) {
      expect(starterMismatches(rel, readFileSync(rel, "utf-8"))).toEqual([]);
    }
  });

  const OVERLAY = [
    "repository:",
    "  description: Standards files",
    '  homepage: ""',
    "  topics: a, b",
    "  private: false",
    "rulesets:",
    "  - name: build-branches",
    "    target: branch",
    "",
  ].join("\n");

  test("an overlay with valid identity keys and only its own ruleset is clean - the control", () => {
    expect(overlayMismatches(OVERLAY)).toEqual([]);
  });

  test.each([
    {
      reason: "the override layer's main ruleset redeclared",
      text: OVERLAY.replace("name: build-branches", "name: main"),
      mismatch: {
        file: OWN_OVERLAY,
        expected: "no 'main' ruleset (the override layer supplies it and wins over this file)",
        got: "declared, which the merge silently overrides",
      },
    },
    {
      reason: "a stringly-typed private key",
      text: OVERLAY.replace("private: false", 'private: "false"'),
      mismatch: {
        file: `${OWN_OVERLAY} repository.private`,
        expected: "an explicit boolean, so the apply manages visibility",
        got: '"false"',
      },
    },
  ])("$reason is the one mismatch", ({ text, mismatch }) => {
    expect(overlayMismatches(text)).toEqual([mismatch]);
  });
});
