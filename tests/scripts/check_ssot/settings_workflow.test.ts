import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import { FLEET_WRITERS, POST_GREEN_REL } from "../../../scripts/check/ssot/post_green.ts";
import {
  OWN_OVERLAY,
  overlayMismatches,
  SETTINGS_ACTION_USES,
  SETTINGS_STARTERS,
  SETTINGS_WORKFLOW,
  settingsApplyInputMismatches,
  settingsIdentityMismatches,
  settingsLaneMismatches,
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

describe("settingsApplyInputMismatches (settings-apply-input)", () => {
  // A minimal well-wired plan job and matrix apply job, mutated per red
  // case below: the negative controls proving the judgment fails through
  // the path its green run takes.
  const APPLY_WITH = [
    "          token: ${{ secrets.REPO_PLATFORM_TOKEN }}",
    "          mode: ${{ inputs.check_only && 'check' || 'apply' }}",
    "          repos: ${{ env.TARGET }}",
    "          private-repos: redact",
    "          private-report: issue",
    "          on-missing-permission: fail",
  ].join("\n");
  const STEP_GATE = "        if: env.TARGET != ''\n";
  const USES = `        uses: ${SETTINGS_ACTION_USES}\n`;
  const SELECT = [
    "      - name: Select settings targets",
    "        id: select",
    "        run: bun .github/scripts/fleet/select_settings_repos.ts",
    "",
  ].join("\n");
  const RESOLVE = [
    "      - name: Resolve the row's target",
    "        env:",
    "          ROW_KEY: ${{ matrix.key }}",
    "          PAT: ${{ secrets.REPO_PLATFORM_TOKEN }}",
    "          GH_TOKEN: ${{ secrets.REPO_PLATFORM_TOKEN }}",
    "          OWNER: ${{ github.repository_owner }}",
    "        run: bun .github/scripts/fleet/resolve_settings_target.ts",
    "",
  ].join("\n");
  const APPLY_STEP = `      - name: Apply repository settings\n${STEP_GATE}${USES}        with:\n${APPLY_WITH}\n`;
  const MATRIX = "      matrix:\n        include: ${{ fromJSON(needs.plan.outputs.matrix) }}\n";
  const JOB_NAME = "    name: apply (row ${{ matrix.row }})\n";
  const valid = `
jobs:
  plan:
    outputs:
      count: \${{ steps.select.outputs.count }}
      matrix: \${{ steps.select.outputs.matrix }}
    steps:
${SELECT}  apply:
    needs: plan
    if: needs.plan.outputs.count != '0'
    strategy:
      fail-fast: false
${MATRIX}${JOB_NAME}    steps:
${RESOLVE}${APPLY_STEP}`;
  const expectedWith =
    "the apply step's with: exactly " +
    '{"token":"${{ secrets.REPO_PLATFORM_TOKEN }}",' +
    "\"mode\":\"${{ inputs.check_only && 'check' || 'apply' }}\"," +
    '"repos":"${{ env.TARGET }}","private-repos":"redact",' +
    '"private-report":"issue","on-missing-permission":"fail"}';
  const expectedMatrix =
    'the apply job\'s matrix the plan\'s row indexes and keys alone: matrix: {"include":"${{ fromJSON(needs.plan.outputs.matrix) }}"}';
  const expectedResolver =
    "a step running bun .github/scripts/fleet/resolve_settings_target.ts IMMEDIATELY BEFORE the apply step (it registers the target's masks and writes TARGET)";
  const expectedResolverEnv =
    "the resolver step's env exactly " +
    '{"ROW_KEY":"${{ matrix.key }}","PAT":"${{ secrets.REPO_PLATFORM_TOKEN }}",' +
    '"GH_TOKEN":"${{ secrets.REPO_PLATFORM_TOKEN }}","OWNER":"${{ github.repository_owner }}"}' +
    " (the row's key, what keyed it, and the listing it resolves against)";

  /** The with: block as the rule reports it (keys sorted): the pinned inputs with `changes` applied, an undefined value dropping its key. */
  const withGot = (changes: Record<string, string | undefined>) => {
    const inputs: Record<string, string | undefined> = {
      token: "${{ secrets.REPO_PLATFORM_TOKEN }}",
      mode: "${{ inputs.check_only && 'check' || 'apply' }}",
      repos: "${{ env.TARGET }}",
      "private-repos": "redact",
      "private-report": "issue",
      "on-missing-permission": "fail",
      ...changes,
    };
    const kept = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== undefined));
    return JSON.stringify(kept, Object.keys(kept).sort());
  };

  test("the synthetic fixture is judged clean - the control for every red case below", () => {
    expect(settingsApplyInputMismatches(valid)).toEqual([]);
  });

  test.each([
    {
      reason: "a repository input beside repos (single-repo mode over a scratch document)",
      text: valid.replace(APPLY_WITH, `${APPLY_WITH}\n          repository: Vivswan/x`),
      expected: expectedWith,
      got: withGot({ repository: "Vivswan/x" }),
    },
    {
      reason: "a settings-file input (a document other than each target's own)",
      text: valid.replace(APPLY_WITH, `${APPLY_WITH}\n          settings-file: merged.yml`),
      expected: expectedWith,
      got: withGot({ "settings-file": "merged.yml" }),
    },
    {
      reason: "a defaults-file input",
      text: valid.replace(APPLY_WITH, `${APPLY_WITH}\n          defaults-file: d.yml`),
      expected: expectedWith,
      got: withGot({ "defaults-file": "d.yml" }),
    },
    {
      reason: "a repos-dir input",
      text: valid.replace(APPLY_WITH, `${APPLY_WITH}\n          repos-dir: repos`),
      expected: expectedWith,
      got: withGot({ "repos-dir": "repos" }),
    },
    {
      reason: 'repos: "*" - the action would discover the fleet itself, adopted or not',
      text: valid.replace("repos: ${{ env.TARGET }}", 'repos: "*"'),
      expected: expectedWith,
      got: withGot({ repos: "*" }),
    },
    {
      reason: "repos read from the matrix instead of the resolved name",
      text: valid.replace("repos: ${{ env.TARGET }}", "repos: ${{ matrix.key }}"),
      expected: expectedWith,
      got: withGot({ repos: "${{ matrix.key }}" }),
    },
    {
      reason:
        "a dropped on-missing-permission (the action's default is fail, but the pin is explicit)",
      text: valid.replace("\n          on-missing-permission: fail", ""),
      expected: expectedWith,
      got: withGot({ "on-missing-permission": undefined }),
    },
    {
      reason: "a mode that ignores check_only",
      text: valid.replace("mode: ${{ inputs.check_only && 'check' || 'apply' }}", "mode: apply"),
      expected: expectedWith,
      got: withGot({ mode: "apply" }),
    },
    {
      reason: "private-repos: show (a private slug in this public log)",
      text: valid.replace("private-repos: redact", "private-repos: show"),
      expected: expectedWith,
      got: withGot({ "private-repos": "show" }),
    },
    {
      reason: "an unpinned uses (a moving tag)",
      text: valid.replace(USES, "        uses: Vivswan/github-settings-as-code@v2\n"),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
      got: "Vivswan/github-settings-as-code@v2",
    },
    {
      reason: "the pin without its version comment",
      text: valid.replace(" # v2.0.0", ""),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
      got: "Vivswan/github-settings-as-code@046adf3b24454f26f569850630809bcf481f8b84",
    },
    {
      // YAML reads this comment as the scalar's own trailing comment; the
      // release-tag verification reads the version off the uses line alone.
      reason: "the version comment on the next line, indented under the uses key",
      text: valid.replace(" # v2.0.0\n", "\n          # v2.0.0\n"),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
      got: "Vivswan/github-settings-as-code@046adf3b24454f26f569850630809bcf481f8b84",
    },
    {
      reason: "the version comment on the next line at the uses key's indentation",
      text: valid.replace(" # v2.0.0\n", "\n        # v2.0.0\n"),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
      got: "Vivswan/github-settings-as-code@046adf3b24454f26f569850630809bcf481f8b84",
    },
    {
      reason:
        "the uses value folded into a block scalar, beside a decoy scalar spelling the pinned line",
      text: valid
        .replace(USES, "        uses: >-\n          Vivswan/github-settings-as-code@v2\n")
        .replace("jobs:\n", `env:\n  DECOY: |\n    uses: ${SETTINGS_ACTION_USES}\njobs:\n`),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
      got: "Vivswan/github-settings-as-code@v2",
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
      got: "0 readable pin(s) for 1 step(s) (an alias or a non-scalar uses)",
    },
    {
      reason: "a stale version comment beside the right sha",
      text: valid.replace(" # v2.0.0", " # v1.9.0"),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
      got: "Vivswan/github-settings-as-code@046adf3b24454f26f569850630809bcf481f8b84 # v1.9.0",
    },
    {
      reason: "an unpinned step beside a decoy carrying the expected line elsewhere in the file",
      text: valid
        .replace(USES, "        uses: Vivswan/github-settings-as-code@v2\n")
        .replace("jobs:\n", `env:\n  DECOY: "${SETTINGS_ACTION_USES}"\njobs:\n`),
      expected: `uses: ${SETTINGS_ACTION_USES}`,
      got: "Vivswan/github-settings-as-code@v2",
    },
    {
      reason: "no gate on the resolved name (an empty repos input is single-repo mode)",
      text: valid.replace(STEP_GATE, ""),
      expected: "the apply step gated on if: env.TARGET != ''",
      got: "no condition",
    },
    {
      reason: "a step gate on the plan's count (not the value applied)",
      text: valid.replace(STEP_GATE, "        if: needs.plan.outputs.count != '0'\n"),
      expected: "the apply step gated on if: env.TARGET != ''",
      got: "if: needs.plan.outputs.count != '0'",
    },
    {
      reason: "a matrix over another plan output (slugs could ride it)",
      text: valid.replace(MATRIX, "      matrix: ${{ fromJSON(needs.plan.outputs.repos) }}\n"),
      expected: expectedMatrix,
      got: 'matrix: "${{ fromJSON(needs.plan.outputs.repos) }}"',
    },
    {
      reason: "a matrix built in the workflow around the plan's output",
      text: valid.replace(
        MATRIX,
        "      matrix:\n        key: ${{ fromJSON(needs.plan.outputs.matrix) }}\n",
      ),
      expected: expectedMatrix,
      got: 'matrix: {"key":"${{ fromJSON(needs.plan.outputs.matrix) }}"}',
    },
    {
      reason: "a plan matrix output built anywhere but the selector (a literal could carry slugs)",
      text: valid.replace(
        "      matrix: ${{ steps.select.outputs.matrix }}",
        '      matrix: \'{"include":[{"row":0,"key":"Vivswan/hidden-repo"}]}\'',
      ),
      expected:
        "the plan job's matrix output wired to the selector's (matrix: ${{ steps.select.outputs.matrix }})",
      got: 'matrix: {"include":[{"row":0,"key":"Vivswan/hidden-repo"}]}',
    },
    {
      reason: "a plan count output built anywhere but the selector",
      text: valid.replace("      count: ${{ steps.select.outputs.count }}", "      count: '1'"),
      expected:
        "the plan job's count output wired to the selector's (count: ${{ steps.select.outputs.count }})",
      got: "count: 1",
    },
    {
      reason: "an apply job that does not need the plan",
      text: valid.replace("    needs: plan\n", ""),
      expected: "the apply job needing plan",
      got: "no needs",
    },
    {
      reason: "no gate on the plan's count (an empty matrix fails the run instead of skipping)",
      text: valid.replace("    if: needs.plan.outputs.count != '0'\n", ""),
      expected:
        "the apply job gated on if: needs.plan.outputs.count != '0' (an empty matrix is a no-op, not a failure)",
      got: "no condition",
    },
    {
      reason: "fail-fast left at GitHub's default (one broken target cancels every other row)",
      text: valid.replace("      fail-fast: false\n", ""),
      expected: "fail-fast: false on the apply job (one target's failure is its own row's red)",
      got: "fail-fast unset (GitHub's default cancels the other rows)",
    },
    {
      reason: "fail-fast: true",
      text: valid.replace("      fail-fast: false\n", "      fail-fast: true\n"),
      expected: "fail-fast: false on the apply job (one target's failure is its own row's red)",
      got: "fail-fast: true",
    },
    {
      reason: "a job name carrying the row's key instead of its index",
      text: valid.replace(JOB_NAME, "    name: apply (${{ matrix.key }})\n"),
      expected: "the apply job named apply (row ${{ matrix.row }}) - an index, never a repository",
      got: "name: apply (${{ matrix.key }})",
    },
    {
      reason: "no resolver step (the apply would read an unmasked value)",
      text: valid.replace(RESOLVE, ""),
      expected: expectedResolver,
      got: "no resolver step",
    },
    {
      reason: "the resolver after the apply step (the masks would come too late)",
      text: valid.replace(RESOLVE + APPLY_STEP, APPLY_STEP + RESOLVE),
      expected: expectedResolver,
      got: "the resolver after the apply step",
    },
    {
      reason: "a step between the resolver and the apply (it could rewrite TARGET)",
      text: valid.replace(
        RESOLVE + APPLY_STEP,
        `${RESOLVE}      - run: echo "TARGET=Vivswan/other" >> "$GITHUB_ENV"\n${APPLY_STEP}`,
      ),
      expected: expectedResolver,
      got: "1 step(s) between the resolver and the apply",
    },
    {
      reason: "a resolver env keyed by something other than the row's key",
      text: valid.replace(
        "          ROW_KEY: ${{ matrix.key }}",
        "          ROW_KEY: ${{ needs.plan.outputs.first }}",
      ),
      expected: expectedResolverEnv,
      got: '{"GH_TOKEN":"${{ secrets.REPO_PLATFORM_TOKEN }}","OWNER":"${{ github.repository_owner }}","PAT":"${{ secrets.REPO_PLATFORM_TOKEN }}","ROW_KEY":"${{ needs.plan.outputs.first }}"}',
    },
    {
      reason: "TARGET set in the apply step's env (the runner prints step env)",
      text: valid.replace(
        `${STEP_GATE}${USES}`,
        `${STEP_GATE}        env:\n          TARGET: Vivswan/x\n${USES}`,
      ),
      expected:
        "no TARGET in an apply step's env (the runner prints step env; the name rides GITHUB_ENV)",
      got: 'step "Apply repository settings" declares TARGET',
    },
    {
      reason: "a re-selection in the apply job (the plan's probes re-run per row)",
      text: valid.replace(RESOLVE, `${SELECT.replace("id: select", "id: reselect")}${RESOLVE}`),
      expected:
        "one selection step in the whole workflow (a re-selection could move a row onto another repository)",
      got: "2 steps running bun .github/scripts/fleet/select_settings_repos.ts, in jobs plan, apply",
    },
  ])("$reason is the one mismatch", ({ text, expected, got }) => {
    expect(settingsApplyInputMismatches(text)).toEqual([
      { file: SETTINGS_WORKFLOW, expected, got },
    ]);
  });

  test("a second job running the action is refused even when both are well-formed", () => {
    const secondJob = `${valid}  apply-again:\n    needs: plan\n    steps:\n${RESOLVE}${APPLY_STEP}`;
    expect(settingsApplyInputMismatches(secondJob)).toEqual([
      {
        file: SETTINGS_WORKFLOW,
        expected: "one job running github-settings-as-code (the matrix job, one target per row)",
        got: "2 jobs",
      },
    ]);
  });

  test("a second apply step is refused even when both are well-formed", () => {
    const second = valid.replace(
      APPLY_STEP,
      APPLY_STEP + APPLY_STEP.replace("Apply repository settings", "Apply again"),
    );
    expect(settingsApplyInputMismatches(second)).toEqual([
      {
        file: SETTINGS_WORKFLOW,
        expected: "one github-settings-as-code step in the apply job (one target per row)",
        got: "2 steps",
      },
    ]);
  });

  test("the selector and the apply in one job (the shape before the matrix) is red, the shape named first", () => {
    const oneJob = `
jobs:
  apply:
    steps:
${SELECT}${APPLY_STEP.replace(STEP_GATE, "        if: steps.select.outputs.repos != ''\n").replace("repos: ${{ env.TARGET }}", "repos: ${{ steps.select.outputs.repos }}")}`;
    const shape = [
      {
        expected: "the apply in a matrix job of its own, fed by the selecting job's outputs",
        got: "the selector and the apply both in the apply job",
      },
      {
        expected:
          "the apply job's count output wired to the selector's (count: ${{ steps.select.outputs.count }})",
        got: "no count output",
      },
      {
        expected:
          "the apply job's matrix output wired to the selector's (matrix: ${{ steps.select.outputs.matrix }})",
        got: "no matrix output",
      },
      { expected: "the apply job needing apply", got: "no needs" },
      {
        expected:
          "the apply job gated on if: needs.apply.outputs.count != '0' (an empty matrix is a no-op, not a failure)",
        got: "no condition",
      },
      {
        expected:
          'the apply job\'s matrix the plan\'s row indexes and keys alone: matrix: {"include":"${{ fromJSON(needs.apply.outputs.matrix) }}"}',
        got: "no matrix",
      },
      {
        expected: "fail-fast: false on the apply job (one target's failure is its own row's red)",
        got: "fail-fast unset (GitHub's default cancels the other rows)",
      },
      {
        expected:
          "the apply job named apply (row ${{ matrix.row }}) - an index, never a repository",
        got: "name: (none)",
      },
      { expected: expectedResolver, got: "no resolver step" },
    ];
    expect(settingsApplyInputMismatches(oneJob)).toEqual(
      shape.map((mismatch) => ({ file: SETTINGS_WORKFLOW, ...mismatch })),
    );
  });

  test.each([
    {
      reason: "no github-settings-as-code step",
      text: valid.replace(APPLY_STEP, ""),
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

describe("settingsLaneMismatches (settings-lane-newest-wins)", () => {
  // The lane's two holders, each built from its cancel-in-progress line
  // (or none): the writer's own workflow-level group and the caller job.
  const workflow = (cancel: string | null) =>
    [
      "concurrency:",
      "  group: settings-repos",
      ...(cancel === null ? [] : [`  cancel-in-progress: ${cancel}`]),
      "jobs: {}",
      "",
    ].join("\n");
  const postGreen = (lane: string[] | null) =>
    [
      "jobs:",
      "  settings-fleet:",
      ...(lane === null ? [] : ["    concurrency:", ...lane.map((line) => `      ${line}`)]),
      "    uses: ./.github/workflows/settings-repos.yml",
      "",
    ].join("\n");
  const CALLER = `${POST_GREEN_REL} job ${FLEET_WRITERS[SETTINGS_WORKFLOW].callerJob}`;
  const expected =
    "cancel-in-progress: false on the settings lane (a lane orders by arrival, so cancelling would let an older commit's late run cancel the newer apply in flight; the selector stands that run down instead)";
  const mismatch = (file: string, got: string) => ({ file, expected, got });

  test("both holders declaring cancel-in-progress: false is the clean shape", () => {
    expect(
      settingsLaneMismatches(
        workflow("false"),
        postGreen(["group: settings-repos", "cancel-in-progress: false"]),
      ),
    ).toEqual([]);
  });

  test.each<{ reason: string; text: string; caller: string; expected: Mismatch[] }>([
    {
      reason: "cancel-in-progress: true on the writer's own lane",
      text: workflow("true"),
      caller: postGreen(["group: settings-repos", "cancel-in-progress: false"]),
      expected: [mismatch(SETTINGS_WORKFLOW, "cancel-in-progress: true")],
    },
    {
      reason:
        "cancel-in-progress left unset on the writer (GitHub's default is false, the pin is the point)",
      text: workflow(null),
      caller: postGreen(["group: settings-repos", "cancel-in-progress: false"]),
      expected: [mismatch(SETTINGS_WORKFLOW, "cancel-in-progress unset")],
    },
    {
      reason: "cancel-in-progress: true on the caller job",
      text: workflow("false"),
      caller: postGreen(["group: settings-repos", "cancel-in-progress: true"]),
      expected: [mismatch(CALLER, "cancel-in-progress: true")],
    },
    {
      reason: "no lane on the caller job at all",
      text: workflow("false"),
      caller: postGreen(null),
      expected: [mismatch(CALLER, "no concurrency block")],
    },
    {
      reason: "both holders wrong: one mismatch each, the writer's first",
      text: workflow("true"),
      caller: postGreen(["group: settings-repos"]),
      expected: [
        mismatch(SETTINGS_WORKFLOW, "cancel-in-progress: true"),
        mismatch(CALLER, "cancel-in-progress unset"),
      ],
    },
  ])("$reason", ({ text, caller, expected }) => {
    expect(settingsLaneMismatches(text, caller)).toEqual(expected);
  });

  test("the live workflow and its caller hold the lane without cancelling", () => {
    expect(
      settingsLaneMismatches(
        readFileSync(SETTINGS_WORKFLOW, "utf-8"),
        readFileSync(POST_GREEN_REL, "utf-8"),
      ),
    ).toEqual([]);
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
    "  - name: stable-tag",
    "    target: tag",
    "",
  ].join("\n");

  test("an overlay with valid identity keys and only its own ruleset is clean - the control", () => {
    expect(overlayMismatches(OVERLAY)).toEqual([]);
  });

  test.each([
    {
      reason: "the override layer's main ruleset redeclared",
      text: OVERLAY.replace("name: stable-tag", "name: main"),
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
