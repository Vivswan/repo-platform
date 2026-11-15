// GitHub's own expression language (@actions/expressions), for tests that read a workflow's `${{ }}` as the runner
// does rather than by its spelling: spacing, quoting, and bracket access included. The parser rejects a context or
// a runner function it was not told, so the lists are the runner's own.

import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import {
  Binary,
  ContextAccess,
  type Expr,
  FunctionCall,
  Grouping,
  IndexAccess,
  Literal,
  Logical,
  Star,
  Unary,
} from "@actions/expressions/ast";
import type { Token } from "@actions/expressions/lexer";
import { truthy } from "@actions/expressions/result";

const CONTEXTS = [
  "github",
  "env",
  "vars",
  "job",
  "jobs",
  "steps",
  "runner",
  "secrets",
  "strategy",
  "matrix",
  "needs",
  "inputs",
];
const STATUS_FUNCTIONS = new Map(
  [
    ["always", true],
    ["cancelled", false],
  ].map(([name, value]) => [
    String(name),
    {
      name: String(name),
      minArgs: 0,
      maxArgs: 0,
      call: () => new data.BooleanData(Boolean(value)),
    },
  ]),
);
const STATUS_FUNCTION_NAMES = new Set(["success", "failure", "cancelled", "always"]);
const RUNNER_FUNCTIONS = [...STATUS_FUNCTION_NAMES, "hashFiles"].map((name) => ({
  name,
  minArgs: 0,
  maxArgs: 255,
}));
const OPEN = "${{";
const CLOSE = "}}";
const PLAIN_NAME = /^[A-Za-z_][\w-]*$/;
const JOB_OR_STEP_KEYS = ["run", "uses", "steps"];

/** One piece of a workflow string: text the runner keeps as written, or the source of one `${{ }}` expression. */
export type TemplateSegment = { literal: string } | { expression: string };

/** One context read, the names from the context down: `steps['build'].outputs.path` is `["steps", "build", "outputs",
 *  "path"]`. A `null` stands where the index is computed (`steps[env.ID]`) or a `*`. */
export type ContextRead = (string | null)[];

/** The index of the `}}` closing an expression whose inside starts at `from`: the first one outside a single-quoted
 *  string, as the runner finds it. A doubled quote inside a string closes and reopens it, which reads the same here. */
function closeOf(text: string, from: number): number {
  let quoted = false;
  for (let at = from; at < text.length; at += 1) {
    if (text[at] === "'") quoted = !quoted;
    if (!quoted && text.startsWith(CLOSE, at)) return at;
  }
  throw new Error(`an expression is never closed in ${text}`);
}

/** The text split as the runner splits a workflow string, in order; no piece is read twice. */
export function templateSegments(text: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let at = 0;
  for (let open = text.indexOf(OPEN); open !== -1; open = text.indexOf(OPEN, at)) {
    const close = closeOf(text, open + OPEN.length);
    if (open > at) segments.push({ literal: text.slice(at, open) });
    segments.push({ expression: text.slice(open + OPEN.length, close).trim() });
    at = close + CLOSE.length;
  }

  if (at < text.length) segments.push({ literal: text.slice(at) });

  return segments;
}

/** The source of every `${{ }}` expression in the text, in order. */
export function expressionsIn(text: string): string[] {
  return templateSegments(text).flatMap((segment) =>
    "expression" in segment ? [segment.expression] : [],
  );
}

/** The source of the one `${{ }}` a value is whole, or null for a value with text around it (a blank included: the
 *  runner keeps it) or more than one. */
export function soleExpression(value: string): string | null {
  const segments = templateSegments(value);
  const [only] = segments;
  return segments.length === 1 && "expression" in only ? only.expression : null;
}

/** The expression an `if:` is: the text itself, or the inside of the one `${{ }}` that wraps it whole. */
export function conditionSource(condition: string): string {
  return soleExpression(condition.trim()) ?? condition.trim();
}

/** The expression's value over the context, each key a dotted path. A key nobody set reads as null, as an unrun job's
 *  output does in Actions. The status functions are the workflow runner's, not the expression language's: a step or
 *  job whose condition passed counts as run only when its chain ran or a status function let it continue, so always()
 *  reads true and cancelled() false here. */
function evaluate(
  expression: string,
  context: Record<string, string | boolean>,
): data.ExpressionData {
  const contexts = new data.Dictionary();
  for (const [path, value] of Object.entries(context)) {
    const keys = path.split(".");
    let node = contexts;
    for (const key of keys.slice(0, -1)) {
      const child = node.get(key) ?? new data.Dictionary();
      if (!(child instanceof data.Dictionary)) throw new Error(`${path}: ${key} is not a mapping`);
      if (node.get(key) === undefined) node.add(key, child);
      node = child;
    }
    node.add(keys[keys.length - 1], data.reviver("", value));
  }
  const tokens = new Lexer(expression).lex().tokens;
  const tree = new Parser(
    tokens,
    contexts.pairs().map((pair) => pair.key),
    [...STATUS_FUNCTIONS.values()],
  ).parse();
  return new Evaluator(tree, contexts, STATUS_FUNCTIONS).evaluate();
}

/** Whether the condition holds over the context. */
export function evaluateCondition(
  expression: string,
  context: Record<string, string | boolean>,
): boolean {
  return truthy(evaluate(expression, context));
}

/** The text as the runner fills a `with:` or `env:` value: every `${{ }}` span replaced by its value over the context. */
export function interpolate(text: string, context: Record<string, string | boolean>): string {
  return templateSegments(text)
    .map((segment) =>
      "expression" in segment
        ? evaluate(segment.expression, context).coerceString()
        : segment.literal,
    )
    .join("");
}

/** The tokens and the tree of one expression's source, the `${{ }}` already stripped. */
export function parseExpression(source: string): { tokens: Token[]; tree: Expr } {
  const { tokens } = new Lexer(source).lex();
  return { tokens, tree: new Parser(tokens, CONTEXTS, RUNNER_FUNCTIONS).parse() };
}

/** The direct subexpressions of a node (none for a literal or a context name), so a walk needs no case per type. */
export function subexpressions(expr: Expr): Expr[] {
  if (expr instanceof Unary) return [expr.expr];

  if (expr instanceof Binary) return [expr.left, expr.right];

  if (expr instanceof Logical || expr instanceof FunctionCall) return expr.args;

  if (expr instanceof Grouping) return [expr.group];

  if (expr instanceof IndexAccess) return [expr.expr, expr.index];

  return [];
}

/** The node inside any parentheses around it. Grouping is the tree's one wrapper that changes no value, so every
 *  reader of a node's kind asks this first and a parenthesis decides nothing. */
export function ungrouped(expr: Expr): Expr {
  return expr instanceof Grouping ? ungrouped(expr.group) : expr;
}

/** The name a literal index reads, or null for a computed one or a `*`. */
export function indexName(index: Expr): string | null {
  const literal = ungrouped(index);
  return literal instanceof Literal ? literal.literal.coerceString() : null;
}

/** The read the node itself is, or null when it is no chain down from a context: `fromJSON(steps.a.outputs.b).c`
 *  holds a read and is none. */
export function contextRead(grouped: Expr): ContextRead | null {
  const expr = ungrouped(grouped);
  if (expr instanceof ContextAccess) return [expr.name.lexeme];

  if (!(expr instanceof IndexAccess)) return null;

  const base = contextRead(expr.expr);
  if (base === null) return null;

  return [...base, indexName(expr.index)];
}

/** The reads inside the computed indexes of a chain: `env.ID` in `steps[env.ID].outputs.path`. */
function indexReads(grouped: Expr): ContextRead[] {
  const expr = ungrouped(grouped);
  if (!(expr instanceof IndexAccess)) return [];

  return [...indexReads(expr.expr), ...contextReads(expr.index)];
}

/** Every context read in the tree, outermost first: `a.b` and `a['b']` are one read, as the runner resolves them. */
export function contextReads(expr: Expr): ContextRead[] {
  const path = contextRead(expr);
  if (path === null) return subexpressions(expr).flatMap(contextReads);

  return [path, ...indexReads(expr)];
}

/** The read a value is whole, as an output wired to one step is (`${{ steps.plan.outputs.modules }}`); null for a
 *  value with text around the expression, more than one expression, or an expression that is no single read. */
export function soleRead(value: string): ContextRead | null {
  const source = soleExpression(value);
  return source === null ? null : contextRead(parseExpression(source).tree);
}

/** Every string a YAML node holds, at any depth, keys left out. */
export function stringsIn(node: unknown): string[] {
  if (typeof node === "string") return [node];

  if (node === null || typeof node !== "object") return [];

  return Object.values(node).flatMap(stringsIn);
}

/** The source of every expression in a YAML node: the `if:` of a job or a step is an expression whole, everywhere
 *  else only the `${{ }}` spans are. An `if` key beside none of a job's or a step's own keys is a name somebody
 *  chose (`env: { if: production }`), so its value is text. */
function expressionSources(node: unknown): string[] {
  if (typeof node === "string") return expressionsIn(node);

  if (node === null || typeof node !== "object") return [];

  const conditional = JOB_OR_STEP_KEYS.some((key) => key in node);
  return Object.entries(node).flatMap(([key, value]) =>
    conditional && key === "if" && typeof value === "string"
      ? [conditionSource(value)]
      : expressionSources(value),
  );
}

/** Every context read of a workflow, a job, a step, or an output spec, as GitHub's parser reads it. */
export function readsIn(node: unknown): ContextRead[] {
  return expressionSources(node).flatMap((source) => contextReads(parseExpression(source).tree));
}

/** The tree in one spelling whatever the source's spacing and quoting, for naming a term in a failure: a literal
 *  name index prints dotted, a computed one in brackets. */
export function printed(expr: Expr): string {
  if (expr instanceof Literal) return expr.token.lexeme;

  if (expr instanceof ContextAccess) return expr.name.lexeme;

  if (expr instanceof Unary) return `${expr.operator.lexeme}${printed(expr.expr)}`;

  if (expr instanceof Binary) {
    return `${printed(expr.left)} ${expr.operator.lexeme} ${printed(expr.right)}`;
  }

  if (expr instanceof Logical) return expr.args.map(printed).join(` ${expr.operator.lexeme} `);

  if (expr instanceof Grouping) return `(${printed(expr.group)})`;

  if (expr instanceof FunctionCall) {
    return `${expr.functionName.lexeme}(${expr.args.map(printed).join(", ")})`;
  }

  if (!(expr instanceof IndexAccess)) throw new Error("an expression node of no known kind");

  const base = printed(expr.expr);
  if (expr.index instanceof Star) return `${base}.*`;

  const { index } = expr;
  const named = index instanceof Literal && index.literal instanceof data.StringData;
  if (named && PLAIN_NAME.test(index.literal.coerceString())) {
    return `${base}.${index.literal.coerceString()}`;
  }

  return `${base}[${printed(index)}]`;
}

/** Every function the expression calls, by lower-cased name, outermost first. */
function calls(expr: Expr): string[] {
  const own = expr instanceof FunctionCall ? [expr.functionName.lexeme.toLowerCase()] : [];
  return [...own, ...subexpressions(expr).flatMap(calls)];
}

/** Every function the condition calls, by lower-cased name, as GitHub's parser reads it. */
export function calledFunctions(condition: string): string[] {
  return calls(parseExpression(condition).tree);
}

/** Whether the condition calls a status function anywhere, as GitHub's parser reads it: a quoted "always()" is a
 *  string, and a call with blanks inside the parentheses or in another case is still the call. */
export function hasStatusFunction(condition: string): boolean {
  return calledFunctions(condition).some((name) => STATUS_FUNCTION_NAMES.has(name));
}
