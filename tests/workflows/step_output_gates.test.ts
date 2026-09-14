import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

// GitHub reads an unrun step's ABSENT output as the number 0, so a condition that tests a step output
// negatively passes when the step never ran, wherever the guarded step is a push, a PR, or an issue
// write. Nothing in-house or in actionlint holds this fact, so every workflow's `if:` is judged here.

const root = join(import.meta.dir, "../..");

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  "continue-on-error"?: boolean | string;
}

/** Only `== '<non-zero literal>'` and `!= ''` cannot be satisfied by an absent output. Terms without a
 *  step output (`env.*`, `needs.*`) are not this hazard. The offending term, or null. */
function unsafeStepCondition(raw: string): string | null {
  // One spelling per term: the `${{ }}` delimiters GitHub accepts around an `if:` go, and a bracket
  // index (`steps['probe'].outputs['changed']`) reads as the dotted path it names.
  const condition = raw
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1")
    .replaceAll(/\[\s*'([\w-]+)'\s*\]/g, ".$1");
  const OUTPUT = /steps\.[\w-]+\.outputs\./;
  if (!OUTPUT.test(condition)) return null;
  // A negated GROUP inverts terms this check reads term by term, so it cannot be proven safe here.
  // `!cancelled()` and friends do not match: the parenthesis has to follow the `!` directly.
  if (/!\s*\(/.test(condition)) return `a negated group: ${condition.trim()}`;
  for (const raw of condition.split(/&&|\|\|/)) {
    const term = raw.replaceAll(/[()]/g, "").trim();
    if (!OUTPUT.test(term)) continue;
    const match = /^steps\.[\w-]+\.outputs\.[\w-]+ (==|!=) '([^']*)'$/.exec(term);
    if (match === null) return term;
    const [, operator, literal] = match;
    if (operator === "==" ? Number(literal) === 0 : literal !== "") return term;
  }
  return null;
}

/** FAIL steps (a bare `exit <non-zero>` last line, no continue-on-error) are exempt: a gate that opens
 *  on an absent output there turns the job red, which is the point. */
function negativeGates(text: string): string[] {
  const doc = parseYaml(text) as { jobs?: Record<string, { steps?: Step[] }> };
  const gates: string[] = [];
  for (const job of Object.values(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const failStep =
        /(^|\n)\s*exit [1-9]\d*$/.test(String(step.run ?? "").trimEnd()) &&
        !step["continue-on-error"];
      if (failStep) continue;
      const unsafe = unsafeStepCondition(String(step.if ?? ""));
      if (unsafe !== null) gates.push(`step "${step.id ?? step.name ?? step.uses}": ${unsafe}`);
    }
  }
  return gates;
}

describe("unsafeStepCondition", () => {
  // Each row pins WHICH term is named: a regression that flags the safe first term of a compound and
  // skips the unsafe one cannot pass.
  test.each([
    ["steps.merge.outputs.skipped != 'true'", "steps.merge.outputs.skipped != 'true'"],
    ["steps.render.outputs.skipped!='true'", "steps.render.outputs.skipped!='true'"],
    ["'true' != steps.merge.outputs.skipped", "'true' != steps.merge.outputs.skipped"],
    ["!steps.merge.outputs.skipped", "!steps.merge.outputs.skipped"],
    ["! steps.merge.outputs.skipped", "! steps.merge.outputs.skipped"],
    [
      "!(steps.merge.outputs.skipped == 'true')",
      "a negated group: !(steps.merge.outputs.skipped == 'true')",
    ],
    [
      "!(success() && steps.merge.outputs.skipped == 'true')",
      "a negated group: !(success() && steps.merge.outputs.skipped == 'true')",
    ],
    // An absent output is null, which Actions compares as the number 0: equal to '', to false, and to
    // every spelling of zero.
    ["steps.merge.outputs.skipped == ''", "steps.merge.outputs.skipped == ''"],
    ["steps.links.outputs.broken == '0'", "steps.links.outputs.broken == '0'"],
    ["steps.links.outputs.broken == '0.0'", "steps.links.outputs.broken == '0.0'"],
    ["steps.merge.outputs.skipped == false", "steps.merge.outputs.skipped == false"],
    ["steps.a.outputs.b == 'false' && steps.c.outputs.d != 'true'", "steps.c.outputs.d != 'true'"],
    ["steps.a.outputs.b == 'false' || !steps.c.outputs.d", "!steps.c.outputs.d"],
    // Bracket indexes name the same output GitHub reads; the term is named in its dotted spelling.
    ["steps.probe.outputs['changed'] != 'true'", "steps.probe.outputs.changed != 'true'"],
    ["steps['probe'].outputs.changed != 'true'", "steps.probe.outputs.changed != 'true'"],
    ["${{ steps.probe.outputs['changed'] != 'true' }}", "steps.probe.outputs.changed != 'true'"],
  ])("rejects %s, naming the offending term", (condition, offending) => {
    expect(unsafeStepCondition(condition)).toBe(offending);
  });

  test.each([
    "steps.merge.outputs.skipped == 'false'",
    "steps.render.outputs.skipped == 'false' && steps.merge.outputs.skipped == 'false'",
    "success() && (steps.apply.outcome == 'success' || steps.render.outputs.skipped == 'true')",
    // always() is not itself the hazard: an absent output still fails the equality.
    "always() && steps.merge.outputs.skipped == 'false'",
    "failure() && env.TARGET_PRIVATE == 'true'",
    // Not a step output: a failed dependency blocks the job outright.
    "needs.plan.outputs.count != '0'",
    "success() && env.TARGET != ''",
    // An absent output compares equal to '', so this inequality fails on it.
    "steps.refresh.outputs.bumps != ''",
    // The delimiters GitHub accepts around an `if:` change nothing.
    "${{ steps.probe.outputs.changed == 'true' }}",
    "${{ steps['probe'].outputs.changed == 'true' }}",
    "",
  ])("accepts %s", (condition) => {
    expect(unsafeStepCondition(condition)).toBeNull();
  });
});

describe("negativeGates", () => {
  const refresh = (condition: string) => `
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - id: changes
        run: bun scripts/refresh.ts
      - name: Commit, push, and open PR
        if: ${condition}
        run: bun scripts/open_pr.ts
`;

  test("a negative gate names the step and the term; the positive gate is clean", () => {
    expect(negativeGates(refresh("steps.changes.outputs.changed != 'true'"))).toEqual([
      "step \"Commit, push, and open PR\": steps.changes.outputs.changed != 'true'",
    ]);
    expect(negativeGates(refresh("steps.changes.outputs.changed == 'true'"))).toEqual([]);
  });

  // The fail-closed re-raise: exempt only while the step provably exits non-zero.
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
    expect(negativeGates(reraise(run, extra))).toEqual(
      red
        ? ["step \"Fail on an integrity finding\": steps.validate.outputs.integrity != 'success'"]
        : [],
    );
  });
});

/** A shipped file as a target's workflow parses: placeholders stubbed, and a `.block.` file (a step list
 *  the writer splices at a workflow's `{{blocks}}` line, indented for that spot) wrapped as one job. */
function asWorkflow(name: string, text: string): string {
  const stubbed = text.replaceAll(/^\{\{blocks\}\}$/gm, "").replaceAll(/\{\{[\w-]+\}\}/g, "x");
  return name.includes(".block.") ? `jobs:\n  spliced:\n    steps:\n${stubbed}` : stubbed;
}

describe("asWorkflow", () => {
  test("a block fragment's negative gate is judged as the spliced step it becomes", () => {
    const block = [
      "      - id: probe",
      "        run: bun x probe",
      "      - name: Format",
      "        if: steps.probe.outputs.changed != 'true'",
      "        run: bun x format",
      "",
    ].join("\n");
    expect(negativeGates(asWorkflow("auto-format.block.toolchain.yml", block))).toEqual([
      "step \"Format\": steps.probe.outputs.changed != 'true'",
    ]);
    expect(
      negativeGates(asWorkflow("checks.block.toolchain.yml", "      # comments only\n")),
    ).toEqual([]);
  });
});

describe("every workflow tests step outputs positively", () => {
  const workflowsUnder = (dir: string): string[] =>
    readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => join(dir, name));
  const own = workflowsUnder(join(root, ".github/workflows"));
  const shipped = readdirSync(join(root, "files"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, "files", entry.name, ".github/workflows"))
    .filter((dir) => existsSync(dir))
    .flatMap(workflowsUnder);
  const files = [...own, ...shipped];

  test("the scan reaches the operator's and the fleet's workflows (ARMED)", () => {
    expect(own.length).toBeGreaterThan(2);
    expect(shipped.filter((path) => path.includes(".block.")).length).toBeGreaterThan(2);
    expect(shipped.filter((path) => !path.includes(".block.")).length).toBeGreaterThan(2);
  });

  test.each(files.map((path) => [relative(root, path), path]))("%s", (_rel, path) => {
    expect(negativeGates(asWorkflow(path, readFileSync(path, "utf8")))).toEqual([]);
  });
});
