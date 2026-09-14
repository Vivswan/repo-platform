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

/** Only `== '<non-zero literal>'`, `!= ''`, and `contains(<output>, '<non-empty literal>')` cannot be satisfied by an
 *  absent output. Terms without a step output (`env.*`, `needs.*`) are not this hazard. The offending term, or null. */
function unsafeStepCondition(raw: string): string | null {
  // One spelling per term: the `${{ }}` delimiters GitHub accepts around an `if:` go, spaces around a
  // dot go, and a literal bracket index (`steps['probe'].outputs['changed']`) reads as the dotted path
  // it names. Context names are case-insensitive to GitHub, so they are matched that way.
  const condition = raw
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1")
    .replaceAll(/\s*\.\s*/g, ".")
    .replaceAll(/\[\s*'([\w-]+)'\s*\]/g, ".$1");
  // A step output is any term reaching `.outputs` from `steps`, a dynamic index (`steps[env.PROBE]`)
  // included: a term the classifier below cannot read is named, never passed.
  const OUTPUT = /(?<![.\w])steps\b.*\.outputs\b/i;
  if (!OUTPUT.test(condition)) return null;
  // A negated GROUP inverts terms this check reads term by term, so it cannot be proven safe here.
  // `!cancelled()` and friends do not match: the parenthesis has to follow the `!` directly.
  if (/!\s*\(/.test(condition)) return `a negated group: ${condition.trim()}`;
  // A parenthesis becomes a space, never nothing: glued to the function name, `contains(steps...` would read as no
  // step output at all.
  for (const raw of condition.split(/&&|\|\|/)) {
    const term = raw.replaceAll(/[()]/g, " ").replaceAll(/\s+/g, " ").trim();
    if (!OUTPUT.test(term)) continue;
    if (/^contains steps\.[\w-]+\.outputs\.[\w-]+, '[^']+'$/i.test(term)) continue;
    const match = /^steps\.[\w-]+\.outputs\.[\w-]+ ?(==|!=) ?'([^']*)'$/i.exec(term);
    if (match === null) return term;
    const [, operator, literal] = match;
    if (operator === "==" ? Number(literal) === 0 : literal !== "") return term;
  }
  return null;
}

/** A FAIL step's gate opening on an absent output turns the job red, which is the point, so it is
 *  exempt. Its lines print and nothing else: no chained command, pipe, or substitution rides on an echo.
 *  The exemption is a heuristic over this repository's own workflows, all authored here: quotes are paired
 *  left to right, and an escaped quote or any construct outside the listed forms is judged effectful, so
 *  the scanner errs toward reporting. */
function isFailStep(step: Step): boolean {
  if (step["continue-on-error"]) return false;
  const run = String(step.run ?? "");
  if (/\\["']/.test(run)) return false;
  const lines = run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const last = lines.at(-1);
  const prints = (line: string) => {
    if (!/^(echo|printf)\b/.test(line)) return false;
    // Quoted text prints, read left to right in ONE pass so a quote of one kind inside the other is
    // text: single quotes hide everything, double quotes hide operators but not a substitution
    // (`$(` or a backtick pair still runs inside them).
    const shell = line.replaceAll(/'[^']*'|"[^"]*"/g, (quoted) =>
      quoted.startsWith("'") ? "" : quoted.replaceAll(/[;|&<>]/g, ""),
    );
    return !/[;|&<>`]|\$\(/.test(shell);
  };
  return last !== undefined && /^exit [1-9]\d*$/.test(last) && lines.slice(0, -1).every(prints);
}

function negativeGates(text: string): string[] {
  const doc = parseYaml(text) as { jobs?: Record<string, { steps?: Step[] }> };
  const gates: string[] = [];
  for (const job of Object.values(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (isFailStep(step)) continue;
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
    // contains('', '') is true, so an empty needle is satisfied by an absent output; a needle with no
    // step output inside is the hazard read the other way round.
    ["contains(steps.plan.outputs.modules, '')", "contains steps.plan.outputs.modules, ''"],
    [
      "contains('\"bun\"', steps.plan.outputs.modules)",
      "contains '\"bun\"', steps.plan.outputs.modules",
    ],
    // Bracket indexes name the same output GitHub reads; the term is named in its dotted spelling.
    ["steps.probe.outputs['changed'] != 'true'", "steps.probe.outputs.changed != 'true'"],
    ["steps['probe'].outputs.changed != 'true'", "steps.probe.outputs.changed != 'true'"],
    ["${{ steps.probe.outputs['changed'] != 'true' }}", "steps.probe.outputs.changed != 'true'"],
    // A dynamic index cannot be read here, so the term is named whatever it compares against.
    ["steps[env.PROBE].outputs.changed != 'true'", "steps[env.PROBE].outputs.changed != 'true'"],
    ["steps[env.PROBE].outputs.changed == 'true'", "steps[env.PROBE].outputs.changed == 'true'"],
    [
      "steps[env[matrix.key]].outputs.changed != 'true'",
      "steps[env[matrix.key]].outputs.changed != 'true'",
    ],
    // GitHub reads these as the plain spelling; so does the classifier.
    ["steps . probe . outputs . changed != 'true'", "steps.probe.outputs.changed != 'true'"],
    ["STEPS.probe.OUTPUTS.changed != 'true'", "STEPS.probe.OUTPUTS.changed != 'true'"],
    // A job named `steps` is a needs term, not this hazard; the unsafe term beside it is the one named.
    [
      "needs.steps.outputs.ready == 'true' && steps.probe.outputs.changed != 'true'",
      "steps.probe.outputs.changed != 'true'",
    ],
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
    // An absent output contains nothing but ''.
    "contains(steps.plan.outputs.modules, '\"bun\"')",
    "!cancelled() && steps.plan.outcome == 'success' && contains(steps.plan.outputs.modules, '\"bun\"')",
    // The delimiters GitHub accepts around an `if:` change nothing.
    "${{ steps.probe.outputs.changed == 'true' }}",
    "STEPS . probe . outputs . changed == 'true'",
    "steps.probe.outputs.changed=='true'",
    "steps.probe.outputs.bumps!=''",
    "needs.steps.outputs.ready == 'true'",
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
    { run: "gh pr merge --squash\nexit 1\n", red: true, shape: "an effect before the exit 1" },
    { run: "echo failed; gh pr merge\nexit 1", red: true, shape: "an effect chained onto an echo" },
    {
      run: 'echo "$(gh pr merge)"\nexit 1',
      red: true,
      shape: "an effect substituted into an echo",
    },
    { run: "echo failed | tee log\nexit 1", red: true, shape: "an echo piped into a command" },
    {
      run: "echo failed & gh pr merge\nexit 1",
      red: true,
      shape: "an effect backgrounded off an echo",
    },
    {
      run: 'echo "can\'t"; gh pr merge "won\'t"\nexit 1',
      red: true,
      shape: "an effect between two double-quoted apostrophes",
    },
    { run: "echo <(gh pr merge)\nexit 1", red: true, shape: "a process substitution in an echo" },
    {
      run: 'echo "`gh pr merge`"\nexit 1',
      red: true,
      shape: "a backtick substitution inside double quotes",
    },
    { run: "echo 'a `b` c'\nexit 1", red: false, shape: "backticks inside single quotes" },
    {
      run: 'echo "x\\""; gh pr merge; echo "x"\nexit 1',
      red: true,
      shape: "an escaped quote desynchronizing the pairs",
    },
    {
      run: 'echo failed > "$GITHUB_OUTPUT"\nexit 1',
      red: true,
      shape: "an echo redirected to a file",
    },
    {
      run: 'echo "failed; see $LOG | above"\nexit 1',
      red: false,
      shape: "punctuation inside quotes",
    },
    {
      run: "# the re-raise\nprintf '%s\\n' 'integrity failed'\n\nexit 3\n",
      red: false,
      shape: "a printf re-raise with a comment and a blank line",
    },
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
