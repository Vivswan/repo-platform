import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  Binary,
  type Expr,
  FunctionCall,
  Grouping,
  Literal,
  Logical,
  Unary,
} from "@actions/expressions/ast";
import { TokenType } from "@actions/expressions/lexer";
import { parse as parseYaml } from "yaml";
import { parseFilesConfig } from "../../actions/plan/files_config.ts";
import {
  type ContextRead,
  conditionSource,
  contextRead,
  contextReads,
  parseExpression,
  printed,
} from "../shared/github_expression.ts";

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

/** Whether the read reaches a step's outputs, a computed step id included. GitHub reads context names in any case. */
function isStepOutput(read: ContextRead): boolean {
  return read[0]?.toLowerCase() === "steps" && read[2]?.toLowerCase() === "outputs";
}

/** Whether the node reads one named output of one named step: `steps.<id>.outputs.<key>`, in any spelling. */
function isNamedOutput(expr: Expr): boolean {
  const read = contextRead(expr);
  return read !== null && read.length === 4 && isStepOutput(read) && !read.includes(null);
}

/** The text of a string literal, or null for any other node. */
function stringLiteral(expr: Expr): string | null {
  const quoted = expr instanceof Literal && expr.token.type === TokenType.STRING;
  return quoted ? expr.literal.coerceString() : null;
}

/** Whether an absent output cannot satisfy the term: `<output> == '<non-zero literal>'`, `<output> != ''`, or
 *  `contains(<output>, '<non-empty literal>')`. */
function failsOnAbsentOutput(term: Expr): boolean {
  if (term instanceof FunctionCall) {
    const [haystack, needle] = term.args;
    const searches =
      term.functionName.lexeme.toLowerCase() === "contains" && term.args.length === 2;
    return searches && isNamedOutput(haystack) && (stringLiteral(needle) ?? "") !== "";
  }

  if (!(term instanceof Binary) || !isNamedOutput(term.left)) return false;

  const literal = stringLiteral(term.right);
  if (literal === null) return false;

  if (term.operator.type === TokenType.EQUAL_EQUAL) return Number(literal) !== 0;

  return term.operator.type === TokenType.BANG_EQUAL && literal === "";
}

/** The first term of the tree an absent step output can satisfy, as text, or null. Terms without a step output
 *  (`env.*`, `needs.*`) are not this hazard, and a computed index (`steps[env.PROBE]`) is named whatever it compares
 *  against. A negated group inverts terms this check reads one by one, so it cannot be proven safe here. */
function unsafeTerm(expr: Expr): string | null {
  if (!contextReads(expr).some(isStepOutput)) return null;

  if (expr instanceof Logical) {
    return expr.args.map(unsafeTerm).find((term) => term !== null) ?? null;
  }

  if (expr instanceof Grouping) return unsafeTerm(expr.group);

  if (expr instanceof Unary && expr.expr instanceof Grouping) {
    return `a negated group: ${printed(expr)}`;
  }

  if (failsOnAbsentOutput(expr)) return null;

  return printed(expr);
}

/** The offending term of an `if:`, or null. */
function unsafeStepCondition(raw: string): string | null {
  const source = conditionSource(raw);
  if (source === "") return null;

  return unsafeTerm(parseExpression(source).tree);
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
    ["steps.render.outputs.skipped!='true'", "steps.render.outputs.skipped != 'true'"],
    ["'true' != steps.merge.outputs.skipped", "'true' != steps.merge.outputs.skipped"],
    ["!steps.merge.outputs.skipped", "!steps.merge.outputs.skipped"],
    ["! steps.merge.outputs.skipped", "!steps.merge.outputs.skipped"],
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
    ["contains(steps.plan.outputs.modules, '')", "contains(steps.plan.outputs.modules, '')"],
    [
      "contains('\"bun\"', steps.plan.outputs.modules)",
      "contains('\"bun\"', steps.plan.outputs.modules)",
    ],
    // Bracket indexes name the same output GitHub reads; every term is named in one spelling.
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
    // An output read inside a call or a group is still read: neither default below needs the step to have run.
    [
      "fromJSON(steps.probe.outputs.json || '{\"ready\":\"yes\"}').ready == 'yes'",
      "fromJSON(steps.probe.outputs.json || '{\"ready\":\"yes\"}').ready == 'yes'",
    ],
    ["(steps.probe).outputs.changed != 'true'", "(steps.probe).outputs.changed != 'true'"],
    [
      "contains(fromJSON('[\"a\"]'), steps.probe.outputs.kind)",
      "contains(fromJSON('[\"a\"]'), steps.probe.outputs.kind)",
    ],
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
    // An operator inside a string literal is text.
    "steps.probe.outputs.kind == 'a||b'",
    "(steps.probe).outputs.changed == 'true'",
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

/** The tree files files.yml splices into a workflow: each a step list indented for its `{{blocks}}` line, wherever it sits under files/. */
const fragments = new Set(
  parseFilesConfig(readFileSync(join(root, "files.yml"), "utf-8")).files.flatMap((entry) =>
    "sources" in entry && entry.path.startsWith(".github/workflows/")
      ? Object.values(entry.sources)
          .filter((source): source is string => typeof source === "string")
          .map((source) => join(root, "files", source))
      : [],
  ),
);

/** A shipped file as a target's workflow parses: placeholders stubbed, and a fragment wrapped as one job. */
function asWorkflow(fragment: boolean, text: string): string {
  const stubbed = text.replaceAll(/^\{\{blocks\}\}$/gm, "").replaceAll(/\{\{[\w-]+\}\}/g, "x");
  return fragment ? `jobs:\n  spliced:\n    steps:\n${stubbed}` : stubbed;
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
    expect(negativeGates(asWorkflow(true, block))).toEqual([
      "step \"Format\": steps.probe.outputs.changed != 'true'",
    ]);
    expect(negativeGates(asWorkflow(true, "      # comments only\n"))).toEqual([]);
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
  const files = [...new Set([...own, ...shipped, ...fragments])];

  test("the scan reaches the operator's and the fleet's workflows (ARMED)", () => {
    expect(own.length).toBeGreaterThan(2);
    expect(fragments.size).toBeGreaterThan(2);
    expect(shipped.filter((path) => !fragments.has(path)).length).toBeGreaterThan(2);
  });

  test.each(files.map((path) => [relative(root, path), path]))("%s", (_rel, path) => {
    expect(negativeGates(asWorkflow(fragments.has(path), readFileSync(path, "utf8")))).toEqual([]);
  });
});
