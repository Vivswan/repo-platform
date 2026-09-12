// Facts are read from the syntax tree, never a regex over the text,
// so a look-alike in a comment, a string, or a template can neither satisfy an anchor nor hide the real declaration.
// Parsing only, no type checker: ts-morph is repo-side tooling (a root devDependency) and must never reach actions/ or the composed build.
//
// When an anchor is lost:
//   constStringValue, constNumberValue, constRegexSource        -> throw naming the file and the fact
//   templateCarries, the type/property probes, moduleSpecifiers -> empty or false; the calling rule owns its anchor-lost throw

import { type Expression, Node, Project, type SourceFile, SyntaxKind } from "ts-morph";

// One shared project; sources are parsed once per distinct text (rules and
// tests re-scan the same bytes many times per run).
const project = new Project({ useInMemoryFileSystem: true });
const parsedByText = new Map<string, SourceFile>();
let serial = 0;

/** A truncated declaration in a recovered tree can read as a benign shape, so any syntax diagnostic throws here;
 *  a caller wanting a softer or better-located failure checks syntaxErrorCount first.
 *  Read-only by contract: the cache hands the same tree to every caller, so mutating it would corrupt later reads of the same text. */
export function parseTs(source: string): SourceFile {
  const errors = syntaxErrorCount(source);
  if (errors > 0) {
    throw new Error(
      `ts_extract: source has ${errors} syntax error(s) - extraction over a recovered tree is unauditable`,
    );
  }
  return parseAny(source);
}

function parseAny(source: string): SourceFile {
  const hit = parsedByText.get(source);
  if (hit !== undefined) return hit;
  const parsed = project.createSourceFile(`/ts-extract-${serial++}.ts`, source);
  parsedByText.set(source, parsed);
  return parsed;
}

function anchorLost(where: string, what: string, detail: string): never {
  throw new Error(`${where}: anchor for ${what} not found (${detail})`);
}

export function syntaxErrorCount(source: string): number {
  const compilerNode = parseAny(source).compilerNode as {
    parseDiagnostics?: readonly unknown[];
  };
  return compilerNode.parseDiagnostics?.length ?? 0;
}

export function unwrapExpression(expression: Expression): Expression {
  let node = expression;
  while (
    Node.isParenthesizedExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isTypeAssertion(node)
  ) {
    node = node.getExpression();
  }
  return node;
}

export function rootIdentifier(expression: Expression): string | null {
  let node = unwrapExpression(expression);
  while (
    Node.isPropertyAccessExpression(node) ||
    Node.isElementAccessExpression(node) ||
    Node.isCallExpression(node)
  ) {
    node = unwrapExpression(node.getExpression());
  }
  return Node.isIdentifier(node) ? node.getText() : null;
}

interface ConstAnchor {
  where: string;
  what: string;
  /** Set where being exported is part of the pinned fact (CHECK_NAME). */
  exported?: boolean;
}

/** Two of the filters refuse decoys the code cannot explain by itself: a local shadow in some function
 *  is not the pinned declaration, and `declare const` carries no initializer semantics. */
function topLevelConst(source: string, name: string, anchor: ConstAnchor) {
  const matches = parseTs(source)
    .getVariableStatements()
    .filter(
      (statement) =>
        statement.getDeclarationKind() === "const" &&
        !statement.hasDeclareKeyword() &&
        statement.getDeclarations().length === 1 &&
        (anchor.exported !== true || statement.isExported()),
    )
    .map((statement) => statement.getDeclarations()[0])
    .filter((declaration) => {
      // The RAW source slice, not getText(): the compiler cooks unicode
      // escapes in identifier text, which would let a decoy spelling
      // match the pinned name.
      const nameNode = declaration.getNameNode();
      return source.slice(nameNode.getStart(), nameNode.getEnd()) === name;
    });
  if (matches.length !== 1) {
    anchorLost(
      anchor.where,
      anchor.what,
      `expected exactly one top-level ${anchor.exported === true ? "exported " : ""}const ${name}, found ${matches.length}`,
    );
  }
  return matches[0];
}

/** A plain literal, or a `+` chain of plain literals (a formatter cannot wrap one long string): the pin stays
 *  a value a reader sees whole, with no identifier or template in it. */
export function constStringValue(source: string, name: string, anchor: ConstAnchor): string {
  const initializer = topLevelConst(source, name, anchor).getInitializer();
  const value = initializer === undefined ? null : literalChain(initializer);
  if (value === null) {
    anchorLost(
      anchor.where,
      anchor.what,
      `const ${name} is not a plain string literal or a + chain of them`,
    );
  }
  return value;
}

function literalChain(node: Expression): string | null {
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  if (
    !Node.isBinaryExpression(node) ||
    node.getOperatorToken().getKind() !== SyntaxKind.PlusToken
  ) {
    return null;
  }
  const left = literalChain(node.getLeft());
  const right = literalChain(node.getRight());
  return left === null || right === null ? null : left + right;
}

export function constNumberValue(source: string, name: string, anchor: ConstAnchor): number {
  const initializer = topLevelConst(source, name, anchor).getInitializer();
  if (initializer === undefined || !Node.isNumericLiteral(initializer)) {
    anchorLost(anchor.where, anchor.what, `const ${name} is not a numeric literal`);
  }
  return Number(initializer.getText().replaceAll("_", ""));
}

/** Flags would make the quoted body an incomplete statement of the regex, so they are a lost anchor. */
export function constRegexSource(source: string, name: string, anchor: ConstAnchor): string {
  const initializer = topLevelConst(source, name, anchor).getInitializer();
  if (initializer === undefined || !Node.isRegularExpressionLiteral(initializer)) {
    anchorLost(anchor.where, anchor.what, `const ${name} is not a regex literal`);
  }
  return regexBody(initializer.getText(), anchor, `const ${name}`);
}

function regexBody(text: string, anchor: ConstAnchor, subject: string): string {
  const close = text.lastIndexOf("/");
  if (!text.startsWith("/") || close <= 0) {
    anchorLost(anchor.where, anchor.what, `${subject} regex text is unreadable`);
  }
  if (text.slice(close + 1) !== "") {
    anchorLost(anchor.where, anchor.what, `${subject} carries regex flags`);
  }
  return text.slice(1, close);
}

/** Raw source slices, never getText(): the compiler cooks unicode escapes, which would let an escape-spelled identifier cook into the pinned one.
 *
 *  ${identifier}     -> its raw text (the only interpolation shape the pinned needles name)
 *  any other ${...}  -> an unmatchable placeholder, so no smuggled string or nested template satisfies a needle whose wiring is gone */
export function templateCarries(source: string, needle: string): boolean {
  const raw = (node: Node) => source.slice(node.getStart(), node.getEnd());
  const interpolated = (node: Expression) => (Node.isIdentifier(node) ? raw(node) : "\u0000");
  return parseTs(source)
    .forEachDescendantAsArray()
    .some((node) => {
      // A template nested inside another template's interpolation is
      // that interpolation's code, not standalone wiring: it was
      // already refused above as a non-identifier interpolation, so
      // visiting it independently would readmit the same decoy.
      if (node.getFirstAncestor(Node.isTemplateExpression) !== undefined) return false;
      if (Node.isNoSubstitutionTemplateLiteral(node)) return raw(node).includes(needle);
      if (!Node.isTemplateExpression(node)) return false;
      const canonical = node
        .getTemplateSpans()
        .reduce(
          (text, span) => text + interpolated(span.getExpression()) + raw(span.getLiteral()),
          raw(node.getHead()),
        );
      return canonical.includes(needle);
    });
}

export function intersectionCarriesType(source: string, name: string): boolean {
  return parseTs(source)
    .forEachDescendantAsArray()
    .some(
      (node) =>
        Node.isIntersectionTypeNode(node) &&
        node.getTypeNodes().some((member) => member.getText() === name),
    );
}

export function propertyAssignmentCarries(source: string, key: string, valueText: string): boolean {
  return parseTs(source)
    .forEachDescendantAsArray()
    .some(
      (node) =>
        Node.isPropertyAssignment(node) &&
        node.getName() === key &&
        node.getInitializer()?.getText() === valueText,
    );
}

export function callCarriesLiteral(source: string, callee: string, firstArg: string): boolean {
  return parseTs(source)
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((call) => {
      if (unwrapExpression(call.getExpression()).getText() !== callee) return false;
      const first = call.getArguments()[0];
      return (
        first !== undefined && Node.isStringLiteral(first) && first.getLiteralValue() === firstArg
      );
    });
}

export function moduleSpecifiers(source: string): { literal: string[]; nonLiteral: string[] } {
  const file = parseTs(source);
  const literalOf = (node: Node | undefined): string | null =>
    node !== undefined && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
      ? node.getLiteralValue()
      : null;
  const literal: string[] = [
    ...file.getImportDeclarations().map((decl) => decl.getModuleSpecifierValue()),
    ...file
      .getExportDeclarations()
      .map((decl) => decl.getModuleSpecifierValue())
      .filter((value): value is string => value !== undefined),
  ];
  const nonLiteral: string[] = [];
  const record = (what: string, value: string | null) => {
    if (value === null) nonLiteral.push(what);
    else literal.push(value);
  };
  for (const decl of file.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const reference = decl.getModuleReference();
    record(
      "import-equals",
      Node.isExternalModuleReference(reference) ? literalOf(reference.getExpression()) : null,
    );
  }
  for (const node of file.getDescendantsOfKind(SyntaxKind.ImportType)) {
    const argument = node.getArgument();
    record(
      "import type",
      Node.isLiteralTypeNode(argument) ? literalOf(argument.getLiteral()) : null,
    );
  }
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const dynamic =
      callee.getKind() === SyntaxKind.ImportKeyword ||
      (Node.isIdentifier(callee) && callee.getText() === "require");
    if (dynamic) record(`${callee.getText()}()`, literalOf(call.getArguments()[0]));
  }
  return { literal, nonLiteral };
}
