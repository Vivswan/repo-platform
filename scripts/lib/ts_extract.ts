// AST-based extraction over TypeScript SOURCES for the SSOT rules: every
// fact a rule pulls out of a .ts file (a pinned const's value, an argv
// array's elements, a template-literal URL shape, a type or property the
// wiring must carry) is read from the parsed syntax tree, never from a
// regex over the raw text - so a look-alike in a comment, a string, or a
// template can neither satisfy an anchor nor hide the real declaration.
// Parsing only, no type checker: ts-morph is repo-side tooling (a root
// devDependency) and must never reach actions/ or the composed build.
//
// Error discipline mirrors check_ssot's split between mustMatch and
// matchAll/includes: the single-fact anchors (the const and argv-run
// readers) THROW naming the file and the fact when the anchor is lost,
// while the presence helpers (templateCarries, the type/property probes,
// moduleSpecifiers) return empty or false and the RULE consuming them
// owns its anchor-lost throw - exactly where the emptiness checks live.

import {
  type CallExpression,
  type PropertyAssignment,
  type Expression,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

// One shared project; sources are parsed once per distinct text (rules and
// tests re-scan the same bytes many times per run).
const project = new Project({ useInMemoryFileSystem: true });
const parsedByText = new Map<string, SourceFile>();
let serial = 0;

/** The parsed source file for `source`, cached by content, ONLY when the
 *  parser recovered nothing: extraction over a recovered tree is unauditable
 *  (a truncated declaration can read as a benign shape), so any syntax
 *  diagnostic throws here, at the one entry every extractor parses through;
 *  callers needing a softer or better-located failure check syntaxErrorCount
 *  first. Read-only by contract: the cache hands the SAME tree to every
 *  caller, so mutating it would corrupt later reads of the same text. */
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

/** Syntactic (parse-level) diagnostics count for `source` - the check
 *  parseTs enforces, exported for callers that name their own file or
 *  fail soft on unauditable text. */
export function syntaxErrorCount(source: string): number {
  const compilerNode = parseAny(source).compilerNode as {
    parseDiagnostics?: readonly unknown[];
  };
  return compilerNode.parseDiagnostics?.length ?? 0;
}

/** An expression with decorative wrappers removed - parentheses, the TS
 *  non-null `!`, and the type-only wrappers (`as`, `satisfies`, angle
 *  assertions), none of which change what runs - so a re-punctuated or
 *  type-dressed spelling reads as its subject. */
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

/** The root identifier of an access/call chain (`Bun.foo().bar` -> Bun),
 *  wrappers unwrapped at every hop; null when the chain bottoms out on
 *  anything but an identifier. */
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
  /** Require the `export` keyword on the declaration (the pinned homes
   *  where being exported IS part of the fact, e.g. CHECK_NAME). */
  exported?: boolean;
}

/** The single top-level `const <name> = <initializer>` declaration.
 *  Top-level only (a local shadow in some function is not the pinned
 *  declaration), exactly one, `const` kind, sole declarator of its
 *  statement, never ambient (`declare const` carries no initializer
 *  semantics), and the name matched on its RAW spelling (a unicode
 *  escape cooking to the pinned name is a decoy, not the declaration).
 *  Anything else is a lost anchor. */
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

/** The string value of a top-level const pinned to a plain string
 *  literal; a concatenation, template, or any other initializer shape is
 *  a lost anchor (the pin must stay a value a reader sees whole). */
export function constStringValue(source: string, name: string, anchor: ConstAnchor): string {
  const initializer = topLevelConst(source, name, anchor).getInitializer();
  if (initializer === undefined || !Node.isStringLiteral(initializer)) {
    anchorLost(anchor.where, anchor.what, `const ${name} is not a plain string literal`);
  }
  return initializer.getLiteralValue();
}

/** The numeric value of a top-level const pinned to a numeric literal
 *  (separator spellings like 60_000 included). */
export function constNumberValue(source: string, name: string, anchor: ConstAnchor): number {
  const initializer = topLevelConst(source, name, anchor).getInitializer();
  if (initializer === undefined || !Node.isNumericLiteral(initializer)) {
    anchorLost(anchor.where, anchor.what, `const ${name} is not a numeric literal`);
  }
  return Number(initializer.getText().replaceAll("_", ""));
}

/** The pattern body of a top-level const pinned to a flagless regex
 *  literal (the text between the slashes - the shape the coupled copies
 *  quote); flags would make the quoted body an incomplete statement of
 *  the regex, so they are a lost anchor. */
export function constRegexSource(source: string, name: string, anchor: ConstAnchor): string {
  const initializer = topLevelConst(source, name, anchor).getInitializer();
  if (initializer === undefined || !Node.isRegularExpressionLiteral(initializer)) {
    anchorLost(anchor.where, anchor.what, `const ${name} is not a regex literal`);
  }
  return regexBody(initializer.getText(), anchor, `const ${name}`);
}

/** The body between a regex literal's slashes; flags are a lost anchor. */
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

/** Whether any TEMPLATE literal in `source` carries `needle` in its RAW
 *  spelling, reconstructed token by token with interpolations contributing
 *  raw text only when they are plain IDENTIFIERS (the only shape the pinned
 *  needles name); anything else contributes an unmatchable placeholder, so
 *  no string or nested template smuggling the needle's characters can
 *  satisfy a needle whose real wiring is gone. Raw source slices, never
 *  getText(): the compiler cooks unicode escapes, which would let an
 *  escape-spelled identifier cook into the pinned one. */
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

/** Whether any intersection type in `source` carries a member spelled
 *  exactly `name` - the `... & RedactionState` wiring shape. */
export function intersectionCarriesType(source: string, name: string): boolean {
  return parseTs(source)
    .forEachDescendantAsArray()
    .some(
      (node) =>
        Node.isIntersectionTypeNode(node) &&
        node.getTypeNodes().some((member) => member.getText() === name),
    );
}

/** Whether any object literal in `source` carries the property
 *  `key: <valueText>` (initializer text compared exactly). */
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

/** Every module specifier `source` names: static imports (type-only
 *  included), re-exports, `import x = require()`, `import("...")` type
 *  nodes, and `import()` / `require()` calls. `nonLiteral` names the
 *  shapes whose specifier is not a string literal, so a caller can fail
 *  closed on them. */
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
    record("import type", Node.isLiteralTypeNode(argument) ? literalOf(argument.getLiteral()) : null);
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
