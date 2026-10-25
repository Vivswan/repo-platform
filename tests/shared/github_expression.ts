// GitHub's own expression language over a context of dotted keys, for tests that judge a workflow's conditions as
// GitHub reads them rather than by their spelling.

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
import { truthy } from "@actions/expressions/result";

const CONTEXTS = ["github", "needs", "steps", "inputs", "matrix", "secrets"];
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
      if (!(child instanceof data.Dictionary)) {
        throw new Error(`${path}: ${key} is not a mapping`);
      }
      if (node.get(key) === undefined) {
        node.add(key, child);
      }
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

const calls = (expr: Expr): string[] => {
  if (expr instanceof FunctionCall) {
    return [expr.functionName.lexeme.toLowerCase(), ...expr.args.flatMap(calls)];
  }
  if (expr instanceof Logical) {
    return expr.args.flatMap(calls);
  }
  if (expr instanceof Grouping) {
    return calls(expr.group);
  }
  if (expr instanceof Unary) {
    return calls(expr.expr);
  }
  if (expr instanceof Binary) {
    return [...calls(expr.left), ...calls(expr.right)];
  }
  if (expr instanceof IndexAccess) {
    return [...calls(expr.expr), ...calls(expr.index)];
  }
  return [];
};

/** Whether the condition calls a status function anywhere, as GitHub's parser reads it: a quoted "always()" is a
 *  string, and a call with blanks inside the parentheses or in another case is still the call. The parser is told
 *  every runner function's name and arity, hashFiles included, or a valid condition fails to parse. */
export function hasStatusFunction(condition: string): boolean {
  const { tokens } = new Lexer(condition).lex();
  const tree = new Parser(tokens, CONTEXTS, RUNNER_FUNCTIONS).parse();
  return calls(tree).some((name) => STATUS_FUNCTION_NAMES.has(name));
}
