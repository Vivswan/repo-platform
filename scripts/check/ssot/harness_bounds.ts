// A harness bound written as a plain number fails a slow but healthy run under load, so every bound in tests/**
// passes through tests/shared/harness_bound.ts's harnessBound (the scale is computed there, once).
//   test("...", fn, 30_000)                         -> harnessBound(30_000)
//   Bun.spawnSync(argv, { timeout: 10_000 })         -> timeout: harnessBound(10_000)
//   expect(Date.now() - start).toBeLessThan(3_000)   -> toBeLessThan(harnessBound(3_000))
// A site that MUST stay absolute (the deadline under test has to fire promptly, so scaling it would hide a
// stuck deadline) carries `absolute-bound:` and its reason in a comment on its line or ending on the line above.
//
// Identifiers resolve through every binding of the name, local and relatively imported, so `const T = 20_000`
// is the literal it holds. What cannot be resolved (a package import, a property read, another call, a spread,
// a parameter) fails closed.

import {
  type CallExpression,
  type Expression,
  Node,
  type ObjectLiteralElementLike,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import {
  parseTs,
  rootIdentifier,
  syntaxErrorCount,
  unwrapExpression,
} from "../../lib/ts_extract.ts";
import type { Mismatch } from "./comparison.ts";
import { resolvedImport } from "./harness_imports.ts";
import { read, walkFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

export const HARNESS_BOUND_HELPER = "tests/shared/harness_bound.ts";
export const ABSOLUTE_MARKER = "absolute-bound:";
/** Every extension bun test runs. */
export const SCANNED_FILE = /\.[mc]?[jt]sx?$/;

const SCALER = "harnessBound";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TIMEOUT_ARGUMENT: Record<string, number> = {
  test: 2,
  it: 2,
  beforeAll: 1,
  afterAll: 1,
  beforeEach: 1,
  afterEach: 1,
  setDefaultTimeout: 0,
};
const JEST_SET_TIMEOUT = "jest.setTimeout";
const UPPER_BOUND_MATCHERS = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);
const LOWER_BOUND_MATCHERS = new Set(["toBeGreaterThan", "toBeGreaterThanOrEqual"]);
// A bound grows with a scaled operand only where that operand cannot shrink it: 10_000 - harnessBound(1_000)
// shrinks under load.
const GROWS_WITH_EITHER_SIDE = new Set([SyntaxKind.PlusToken, SyntaxKind.AsteriskToken]);
const GROWS_WITH_LEFT_SIDE = new Set([SyntaxKind.MinusToken, SyntaxKind.SlashToken]);
const MARKER_WITH_REASON = new RegExp(`${ABSOLUTE_MARKER}[ \\t]*[^\\s*/]`);

type Verdict = "scaled" | "literal" | "unauditable";

interface Resolver {
  /** Repository-relative path -> source, or null when the file does not exist. */
  source: (rel: string) => string | null;
}

interface Scope {
  rel: string;
  file: SourceFile;
}

type Binding =
  | { via: "declaration"; value: Expression | undefined }
  | { via: "assignment"; value: Expression; plain: boolean }
  | { via: "parameter" };

function worstOf(verdicts: Verdict[]): Verdict {
  if (verdicts.every((v) => v === "scaled")) return "scaled";
  return verdicts.includes("literal") ? "literal" : "unauditable";
}

function namedAs(node: Node, name: string): boolean {
  return Node.isIdentifier(node) && node.getText() === name;
}

function bindingsOf(file: SourceFile, name: string): Binding[] {
  const bindings: Binding[] = [];
  for (const node of file.forEachDescendantAsArray()) {
    if (Node.isParameterDeclaration(node) && namedAs(node.getNameNode(), name)) {
      bindings.push({ via: "parameter" });
    } else if (Node.isVariableDeclaration(node) && namedAs(node.getNameNode(), name)) {
      bindings.push({ via: "declaration", value: node.getInitializer() });
    } else if (Node.isBinaryExpression(node) && namedAs(node.getLeft(), name)) {
      const operator = node.getOperatorToken().getKind();
      if (operator < SyntaxKind.FirstAssignment || operator > SyntaxKind.LastAssignment) continue;
      bindings.push({
        via: "assignment",
        value: node.getRight(),
        plain: operator === SyntaxKind.EqualsToken,
      });
    }
  }
  return bindings;
}

type Imported = { scope: Scope; name: string } | "none" | "unresolved";

function importedDeclaration(scope: Scope, name: string, resolver: Resolver): Imported {
  for (const declaration of scope.file.getImportDeclarations()) {
    const whole = [declaration.getDefaultImport(), declaration.getNamespaceImport()];
    if (whole.some((binding) => binding?.getText() === name)) return "unresolved";
    const named = declaration
      .getNamedImports()
      .find(
        (specifier) => (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === name,
      );
    if (named === undefined) continue;
    const stem = resolvedImport(scope.rel, declaration.getModuleSpecifierValue());
    if (stem === null) return "unresolved";
    for (const extension of SOURCE_EXTENSIONS) {
      const rel = `${stem}${extension}`;
      const source = resolver.source(rel);
      if (source === null || syntaxErrorCount(source) > 0) continue;
      return { scope: { rel, file: parseTs(source) }, name: named.getNameNode().getText() };
    }
    return "unresolved";
  }
  return "none";
}

/** Every binding of the name counts, a shadow in some scope and an import of the same name included: over-flagging
 *  is the loud direction. */
function identifierVerdict(
  scope: Scope,
  name: string,
  resolver: Resolver,
  visiting: Set<string>,
): Verdict {
  const key = `${scope.rel}#${name}`;
  if (visiting.has(key)) return "unauditable";
  visiting.add(key);
  const verdicts = bindingsOf(scope.file, name).map((binding): Verdict => {
    if (binding.via === "parameter") return "unauditable";
    if (binding.via === "assignment" && !binding.plain) return "unauditable";
    if (binding.value === undefined) return "unauditable";
    return valueVerdict(binding.value, scope, resolver, visiting);
  });
  const imported = importedDeclaration(scope, name, resolver);
  if (imported === "unresolved") verdicts.push("unauditable");
  else if (imported !== "none") {
    verdicts.push(identifierVerdict(imported.scope, imported.name, resolver, visiting));
  }
  visiting.delete(key);
  return verdicts.length === 0 ? "unauditable" : worstOf(verdicts);
}

export function valueVerdict(
  expression: Expression,
  scope: Scope,
  resolver: Resolver,
  visiting: Set<string> = new Set(),
): Verdict {
  const node = unwrapExpression(expression);
  if (Node.isNumericLiteral(node) || Node.isBigIntLiteral(node)) return "literal";
  if (Node.isPrefixUnaryExpression(node)) {
    return valueVerdict(node.getOperand(), scope, resolver, visiting);
  }
  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getKind();
    const [left, right] = [node.getLeft(), node.getRight()].map((side) =>
      valueVerdict(side, scope, resolver, visiting),
    );
    if (GROWS_WITH_EITHER_SIDE.has(operator) && (left === "scaled" || right === "scaled")) {
      return "scaled";
    }
    if (GROWS_WITH_LEFT_SIDE.has(operator) && left === "scaled") return "scaled";
    if (!GROWS_WITH_EITHER_SIDE.has(operator) && !GROWS_WITH_LEFT_SIDE.has(operator)) {
      return "unauditable";
    }
    return worstOf([left, right]);
  }
  if (Node.isCallExpression(node)) {
    const callee = unwrapExpression(node.getExpression());
    return Node.isIdentifier(callee) && callee.getText() === SCALER ? "scaled" : "unauditable";
  }
  if (Node.isIdentifier(node)) return identifierVerdict(scope, node.getText(), resolver, visiting);
  return "unauditable";
}

const CLOCK_CALLS = new Set(["Date.now", "performance.now", "Bun.nanoseconds", "process.hrtime"]);

/** process.cpuUsage is not a clock: tests/shared/cpu_growth.ts measures CPU time with it, which load barely moves. */
function readsClock(expression: Expression, scope: Scope, visiting: Set<string>): boolean {
  for (const node of [expression, ...expression.getDescendants()]) {
    if (Node.isNewExpression(node) && node.getExpression().getText() === "Date") {
      if (node.getArguments().length === 0) return true;
    }
    if (Node.isCallExpression(node)) {
      const callee = unwrapExpression(node.getExpression())
        .getText()
        .replace(/\.bigint$/, "");
      if (CLOCK_CALLS.has(callee)) return true;
    }
    if (!Node.isIdentifier(node)) continue;
    const parent = node.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) continue;
    const key = `${scope.rel}#clock#${node.getText()}`;
    if (visiting.has(key)) continue;
    visiting.add(key);
    const clockDerived = bindingsOf(scope.file, node.getText()).some(
      (binding) =>
        binding.via !== "parameter" &&
        binding.value !== undefined &&
        readsClock(binding.value, scope, visiting),
    );
    if (clockDerived) return true;
  }
  return false;
}

/** The lines a marker comment (the marker and a reason) excuses: a comment trailing code excuses its own lines,
 *  one on lines of its own excuses the line after it. A marker in a string or a test name is text, not a marker.
 *  Tokens are walked too: a comment trailing `30_000,` belongs to no node. */
function markedLines(file: SourceFile): Set<number> {
  const text = file.getFullText();
  const lines = new Set<number>();
  const seen = new Set<number>();
  const visit = (node: Node) => {
    for (const range of [...node.getLeadingCommentRanges(), ...node.getTrailingCommentRanges()]) {
      if (seen.has(range.getPos())) continue;
      seen.add(range.getPos());
      if (!MARKER_WITH_REASON.test(range.getText())) continue;
      const first = file.getLineAndColumnAtPos(range.getPos()).line;
      const last = file.getLineAndColumnAtPos(range.getEnd()).line;
      const before = text.slice(text.lastIndexOf("\n", range.getPos() - 1) + 1, range.getPos());
      const lineEnd = text.indexOf("\n", range.getEnd());
      const after = text.slice(range.getEnd(), lineEnd === -1 ? text.length : lineEnd);
      if (/^\s*$/.test(before) && /^\s*$/.test(after)) lines.add(last + 1);
      else for (let line = first; line <= last; line += 1) lines.add(line);
    }
    for (const child of node.getChildren()) visit(child);
  };
  visit(file);
  return lines;
}

/** The subject of an upper bound on the expectation: `.not` turns toBeLessThan into a lower bound (which load
 *  only helps) and toBeGreaterThan into an upper one. */
function upperBoundSubject(matcherCall: CallExpression): Expression | null {
  const callee = unwrapExpression(matcherCall.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const matcher = callee.getName();
  if (!UPPER_BOUND_MATCHERS.has(matcher) && !LOWER_BOUND_MATCHERS.has(matcher)) return null;
  let negated = false;
  let receiver: Expression = unwrapExpression(callee.getExpression());
  while (Node.isPropertyAccessExpression(receiver)) {
    if (receiver.getName() === "not") negated = !negated;
    receiver = unwrapExpression(receiver.getExpression());
  }
  if (!Node.isCallExpression(receiver)) return null;
  const expectCallee = unwrapExpression(receiver.getExpression());
  if (!Node.isIdentifier(expectCallee) || expectCallee.getText() !== "expect") return null;
  if (UPPER_BOUND_MATCHERS.has(matcher) === negated) return null;
  return (receiver.getArguments()[0] as Expression | undefined) ?? null;
}

function isBunSpawn(call: CallExpression): boolean {
  const callee = unwrapExpression(call.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return false;
  if (callee.getName() !== "spawn" && callee.getName() !== "spawnSync") return false;
  const receiver = unwrapExpression(callee.getExpression());
  if (Node.isIdentifier(receiver)) return receiver.getText() === "Bun";
  return Node.isPropertyAccessExpression(receiver) && receiver.getName() === "Bun";
}

function propertyKey(property: ObjectLiteralElementLike): string | null {
  if (Node.isSpreadAssignment(property)) return null;
  const name = property.getNameNode();
  if (name === undefined) return null;
  if (Node.isIdentifier(name)) return name.getText();
  if (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name)) {
    return name.getLiteralText();
  }
  return null;
}

type OptionsTimeout =
  | { found: "value"; value: Expression }
  | { found: "none" }
  | { found: "unauditable"; at: Node };

/** The `timeout` an options object carries. A variable is read from its one declaration; a spread, a computed
 *  key, an import of the variable's name, or an object the scan cannot see fails closed. */
function timeoutOf(
  options: Expression,
  scope: Scope,
  resolver: Resolver,
  visiting: Set<string> = new Set(),
): OptionsTimeout {
  const node = unwrapExpression(options);
  if (Node.isIdentifier(node)) {
    const key = `${scope.rel}#options#${node.getText()}`;
    if (visiting.has(key)) return { found: "unauditable", at: node };
    visiting.add(key);
    const bindings = bindingsOf(scope.file, node.getText());
    const [only] = bindings;
    if (
      bindings.length === 1 &&
      only?.via === "declaration" &&
      only.value !== undefined &&
      importedDeclaration(scope, node.getText(), resolver) === "none"
    ) {
      return timeoutOf(only.value, scope, resolver, visiting);
    }
    return { found: "unauditable", at: node };
  }
  if (!Node.isObjectLiteralExpression(node)) return { found: "unauditable", at: node };
  let timeout: OptionsTimeout = { found: "none" };
  for (const property of node.getProperties()) {
    const key = propertyKey(property);
    if (key === null) return { found: "unauditable", at: property };
    if (key !== "timeout") continue;
    if (Node.isShorthandPropertyAssignment(property)) {
      timeout = { found: "value", value: property.getNameNode() };
    } else if (Node.isPropertyAssignment(property) && property.getInitializer() !== undefined) {
      timeout = { found: "value", value: property.getInitializerOrThrow() };
    } else {
      return { found: "unauditable", at: property };
    }
  }
  return timeout;
}

/** Bun.spawn(argv, options) or Bun.spawn({ cmd, ...options }); an argv variable alone is no options at all. */
function spawnOptions(call: CallExpression, scope: Scope): Expression | null {
  const args = call.getArguments() as Expression[];
  if (args.length >= 2) return args[1] ?? null;
  const first = args[0] === undefined ? null : unwrapExpression(args[0]);
  if (first === null || Node.isArrayLiteralExpression(first)) return null;
  if (!Node.isIdentifier(first)) return first;
  const bindings = bindingsOf(scope.file, first.getText());
  const argvOnly =
    bindings.length > 0 &&
    bindings.every(
      (binding) =>
        binding.via !== "parameter" &&
        binding.value !== undefined &&
        Node.isArrayLiteralExpression(unwrapExpression(binding.value)),
    );
  return argvOnly ? null : first;
}

/** `jest.setTimeout(ms)`, the one timeout setter whose root identifier is not the setter itself. */
function timeoutArgumentPosition(call: CallExpression): number | undefined {
  if (unwrapExpression(call.getExpression()).getText() === JEST_SET_TIMEOUT) return 0;
  const root = rootIdentifier(call.getExpression());
  return root === null ? undefined : TIMEOUT_ARGUMENT[root];
}

export interface BoundSite {
  line: number;
  kind: "test timeout" | "spawn timeout" | "wall-clock bound";
  verdict: Verdict;
  marked: boolean;
}

export function boundSites(rel: string, source: string, resolver: Resolver): BoundSite[] {
  if (/\.[jt]sx$/.test(rel)) {
    throw new Error(
      `${rel}: a JSX test file is outside the bound scan (scripts/lib/ts_extract.ts parses TypeScript only)`,
    );
  }
  if (syntaxErrorCount(source) > 0) {
    throw new Error(`${rel}: source has syntax errors - the bound scan cannot audit it`);
  }
  const scope: Scope = { rel, file: parseTs(source) };
  const marks = markedLines(scope.file);
  const sites: BoundSite[] = [];
  const record = (kind: BoundSite["kind"], at: Node, verdict: Verdict) => {
    const line = at.getStartLineNumber();
    sites.push({ line, kind, verdict, marked: marks.has(line) });
  };
  const recordValue = (kind: BoundSite["kind"], value: Expression) =>
    record(kind, value, valueVerdict(value, scope, resolver));
  const recordOptions = (kind: BoundSite["kind"], options: Expression) => {
    const timeout = timeoutOf(options, scope, resolver);
    if (timeout.found === "value") recordValue(kind, timeout.value);
    else if (timeout.found === "unauditable") record(kind, timeout.at, "unauditable");
  };
  const holdsObject = (expression: Expression): boolean => {
    const node = unwrapExpression(expression);
    if (Node.isObjectLiteralExpression(node)) return true;
    if (!Node.isIdentifier(node)) return false;
    return bindingsOf(scope.file, node.getText()).some(
      (binding) =>
        binding.via !== "parameter" &&
        binding.value !== undefined &&
        Node.isObjectLiteralExpression(unwrapExpression(binding.value)),
    );
  };
  for (const call of scope.file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const args = call.getArguments() as Expression[];
    const subject = upperBoundSubject(call);
    if (subject !== null) {
      if (args[0] !== undefined && readsClock(subject, scope, new Set())) {
        recordValue("wall-clock bound", args[0]);
      }
      continue;
    }
    if (isBunSpawn(call)) {
      const options = spawnOptions(call, scope);
      if (options !== null) recordOptions("spawn timeout", options);
      continue;
    }
    const position = timeoutArgumentPosition(call);
    if (position === undefined) continue;
    const argument = args[position];
    if (argument === undefined) continue;
    if (holdsObject(argument)) recordOptions("test timeout", argument);
    else recordValue("test timeout", argument);
  }
  return sites.sort((a, b) => a.line - b.line);
}

export function harnessBoundMismatches(
  rel: string,
  source: string,
  resolver: Resolver,
): { mismatches: Mismatch[]; audited: number } {
  const sites = boundSites(rel, source, resolver);
  const mismatches: Mismatch[] = [];
  for (const site of sites) {
    if (site.verdict === "scaled" || site.marked) continue;
    mismatches.push({
      file: `${rel}:${site.line}`,
      expected: `a ${site.kind} through ${SCALER}(...) (${HARNESS_BOUND_HELPER}), or the \`${ABSOLUTE_MARKER}\` marker with its reason in a comment on the line or ending on the line above, when the deadline under test must fire promptly`,
      got:
        site.verdict === "literal"
          ? "a plain number, which fails a slow but healthy run under load"
          : "a value the scan cannot resolve to a number or to harnessBound",
    });
  }
  return { mismatches, audited: sites.length };
}

export const harnessBoundRules: Rule[] = [
  {
    name: "harness-bounds-scale",
    run: () => {
      const files = walkFiles("tests")
        .filter((f) => !f.symlink && SCANNED_FILE.test(f.path))
        .map((f) => f.path);
      if (!files.includes(HARNESS_BOUND_HELPER)) {
        throw new Error(
          `${HARNESS_BOUND_HELPER}: the harness bound helper is missing - anchor lost`,
        );
      }
      const present = new Set(files);
      const resolver: Resolver = { source: (rel) => (present.has(rel) ? read(rel) : null) };
      const mismatches: Mismatch[] = [];
      let audited = 0;
      for (const rel of files) {
        const found = harnessBoundMismatches(rel, read(rel), resolver);
        mismatches.push(...found.mismatches);
        audited += found.audited;
      }
      if (audited === 0) throw new Error("no bound site found under tests/ - anchor lost");
      return mismatches;
    },
  },
];
