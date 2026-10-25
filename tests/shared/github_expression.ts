// GitHub's own expression language (@actions/expressions), for tests that read a workflow's `${{ }}` as the runner
// does rather than by its spelling: spacing, quoting, and bracket access included. The parser rejects a context or
// a runner function it was not told, so the lists are the runner's own.

import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import {
  Binary,
  type Expr,
  FunctionCall,
  Grouping,
  IndexAccess,
  Logical,
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

/** Whether the condition holds over the context. A key nobody set reads as null, as an unrun job's output does in
 *  Actions. The status functions are the workflow runner's, not the expression language's: a step or job whose
 *  condition passed counts as run only when its chain ran or a status function let it continue, so always() reads
 *  true and cancelled() false here. */
export function evaluateCondition(expression: string, context: Record<string, string>): boolean {
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
    node.add(keys[keys.length - 1], new data.StringData(value));
  }
  const tokens = new Lexer(expression).lex().tokens;
  const tree = new Parser(
    tokens,
    contexts.pairs().map((pair) => pair.key),
    [...STATUS_FUNCTIONS.values()],
  ).parse();
  return truthy(new Evaluator(tree, contexts, STATUS_FUNCTIONS).evaluate());
}

const STATUS_FUNCTION_NAMES = new Set(["success", "failure", "cancelled", "always"]);
const RUNNER_FUNCTIONS = [...STATUS_FUNCTION_NAMES, "hashFiles"].map((name) => ({
  name,
  minArgs: 0,
  maxArgs: 255,
}));

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

/** Every function the expression calls, by lower-cased name, outermost first. */
function calls(expr: Expr): string[] {
  const own = expr instanceof FunctionCall ? [expr.functionName.lexeme.toLowerCase()] : [];
  return [...own, ...subexpressions(expr).flatMap(calls)];
}

/** Whether the condition calls a status function anywhere, as GitHub's parser reads it: a quoted "always()" is a
 *  string, and a call with blanks inside the parentheses or in another case is still the call. */
export function hasStatusFunction(condition: string): boolean {
  return calls(parseExpression(condition).tree).some((name) => STATUS_FUNCTION_NAMES.has(name));
}
