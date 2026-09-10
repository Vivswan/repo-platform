// The migration ladder's rules: every rung bound to its test, harness case,
// and docs mention; rungs self-contained; retired shapes spelled nowhere else.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type CallExpression, Node, SyntaxKind } from "ts-morph";
import { RUNG_FILE_RE, RUNG_ID_BODY } from "../../../.github/scripts/sync/run_migrations.ts";
import { PENDING_RUNGS } from "../../../tests/ci/upgrade_path/rungs.ts";
import { parseTs, unwrapExpression } from "../../lib/ts_extract.ts";
import type { Mismatch } from "./comparison.ts";
import { REPO_ROOT, read, walkFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

export const MIGRATIONS_DIR_REL = ".github/scripts/sync/migrations";

export const MIGRATIONS_TESTS_REL = "tests/sync/migrations";

/** The upgrade-path harness's table of the rungs its synthetic old build
 *  leaves pending (PENDING_RUNGS): a rung's harness case is its entry. */
export const MIGRATIONS_HARNESS_REL = "tests/ci/upgrade_path/rungs.ts";

export const MIGRATIONS_DOC_REL = "docs/migrations.md";

/** The docs heading under which pruned rungs keep their ids. */
export const PRUNED_HEADING = "## Pruned from main";

/** How a rung's test imports its rung (tests/sync/migrations/ to the
 *  ladder directory), the exact specifier a decoy path cannot share. */
export const rungTestSpecifier = (id: string) => `../../../${MIGRATIONS_DIR_REL}/${id}.ts`;

/** Whole-token occurrences of rung ids in prose or code: the id grammar
 *  bounded by non-identifier characters, so `m0001_a` is never read
 *  inside `m0001_a_b`. */
export function migrationIdTokens(text: string): Set<string> {
  return new Set(
    text.match(new RegExp(`(?<![A-Za-z0-9_])${RUNG_ID_BODY}(?![A-Za-z0-9_])`, "g")) ?? [],
  );
}

/** A rung file's default export: the one `export default` whose value is
 *  an object literal of plain members (no spread, no computed name - a
 *  later spread could overwrite what the anchors read) carrying exactly
 *  one function-valued `apply` and exactly one `id` that is a plain string
 *  literal - its id; null for any other shape. */
export function rungExport(source: string): { id: string } | null {
  const assignments = parseTs(source)
    .getExportAssignments()
    .filter((assignment) => !assignment.isExportEquals());
  if (assignments.length !== 1) return null;
  const object = unwrapExpression(assignments[0].getExpression());
  if (!Node.isObjectLiteralExpression(object)) return null;
  const members = object.getProperties();
  const plain = members.every(
    (member) =>
      (Node.isMethodDeclaration(member) || Node.isPropertyAssignment(member)) &&
      !Node.isComputedPropertyName(member.getNameNode()),
  );
  if (!plain) return null;
  const named = (name: string) =>
    members
      .filter((member) => Node.isMethodDeclaration(member) || Node.isPropertyAssignment(member))
      .filter((member) => member.getName() === name);
  const [apply, ...moreApply] = named("apply");
  const [id, ...moreId] = named("id");
  if (apply === undefined || moreApply.length > 0 || id === undefined || moreId.length > 0) {
    return null;
  }
  const applyValue = Node.isMethodDeclaration(apply)
    ? apply
    : Node.isPropertyAssignment(apply)
      ? unwrapExpression(apply.getInitializerOrThrow())
      : undefined;
  if (
    applyValue === undefined ||
    !(
      Node.isMethodDeclaration(applyValue) ||
      Node.isFunctionExpression(applyValue) ||
      Node.isArrowFunction(applyValue)
    )
  ) {
    return null;
  }
  if (!Node.isPropertyAssignment(id)) return null;
  const value = id.getInitializer();
  if (value === undefined || !Node.isStringLiteral(value)) return null;
  return { id: value.getLiteralValue() };
}

/** Every identifier of `node` in a value position: anything under a type
 *  node (`typeof x`, a type reference) reads a binding without running it. */
function valueIdentifiers(node: Node): string[] {
  return node
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((identifier) => identifier.getFirstAncestor((a) => Node.isTypeNode(a)) === undefined)
    .map((identifier) => identifier.getText());
}

/** Whether a rung's test file is bound to the rung: the rung's default
 *  export imported from its exact specifier, bun:test's `test` imported
 *  unshadowed and called, the rung's `apply` called (on the import or a
 *  binding assigned from it), and the rung reached from a test call
 *  (directly or through top-level helpers). Null when it is; the
 *  shortfall otherwise. Binding and exercise only: whether the test pins
 *  behavior is review's question. */
export function rungTestShortfall(source: string, id: string): string | null {
  const file = parseTs(source);
  const rungImports = file
    .getImportDeclarations()
    .filter((decl) => decl.getModuleSpecifierValue() === rungTestSpecifier(id));
  if (rungImports.length === 0) return `no import from "${rungTestSpecifier(id)}"`;
  // A type-only import may sit beside the value import; the value one
  // must exist and must be the DEFAULT export (the rung object itself).
  const valueImport = rungImports.find(
    (decl) => !decl.isTypeOnly() && decl.getDefaultImport() !== undefined,
  );
  if (valueImport === undefined) return "the rung import is type-only or names no default import";
  const local = (valueImport.getDefaultImport() as Node).getText();
  const runners = file
    .getImportDeclarations()
    .filter((decl) => decl.getModuleSpecifierValue() === "bun:test" && !decl.isTypeOnly())
    .flatMap((decl) => decl.getNamedImports())
    .filter(
      (named) =>
        named.getAliasNode() === undefined &&
        !named.isTypeOnly() &&
        ["test", "describe"].includes(named.getName()),
    )
    .map((named) => named.getName());
  if (!runners.includes("test")) return "no test imported from bun:test";
  // Every name a declaration or parameter binds, destructuring patterns
  // walked (`const { test } = fake` binds `test`).
  const declared = [
    ...file.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).map((fn) => fn.getName()),
    ...file.getDescendantsOfKind(SyntaxKind.ClassDeclaration).map((cls) => cls.getName()),
    ...file.getDescendantsOfKind(SyntaxKind.ClassExpression).map((cls) => cls.getName()),
    ...file.getDescendantsOfKind(SyntaxKind.FunctionExpression).map((fn) => fn.getName()),
    ...file.getDescendantsOfKind(SyntaxKind.EnumDeclaration).map((en) => en.getName()),
    ...file.getDescendantsOfKind(SyntaxKind.BindingElement).map((el) => el.getNameNode().getText()),
    ...[
      ...file.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
      ...file.getDescendantsOfKind(SyntaxKind.Parameter),
    ]
      .map((d) => d.getNameNode())
      .filter((node) => Node.isIdentifier(node))
      .map((node) => node.getText()),
  ];
  if (declared.some((name) => name === "test" || name === "describe")) {
    return "a declaration or parameter named test or describe shadows the bun:test runner";
  }
  if (declared.includes(local)) {
    return `a declaration or parameter named ${local} shadows the rung import`;
  }
  // A REGISTERED test: `test(...)`, or the outer invocation of
  // `test.each(...)(...)` - never `.skip`/`.todo`/`.if` - on a path that
  // certainly executes (`registered` below).
  const isRunner = (node: Node, name: string) => Node.isIdentifier(node) && node.getText() === name;
  const isEachOf = (callee: Node, name: string) => {
    if (!Node.isCallExpression(callee)) return false;
    const access = callee.getExpression();
    return (
      Node.isPropertyAccessExpression(access) &&
      isRunner(access.getExpression(), name) &&
      access.getName() === "each"
    );
  };
  // Only a runner imported from bun:test registers anything (a foreign
  // `describe` may ignore its callback).
  const registers = (call: CallExpression, name: string) =>
    runners.includes(name) &&
    (isRunner(call.getExpression(), name) || isEachOf(call.getExpression(), name));
  // Registered = the call is a statement of the module itself, or a
  // statement (or the expression body) of the callback argument of an
  // enabled describe that is itself registered. Anything else - a loop,
  // a conditional, a short-circuit, an uncalled function, a class member -
  // is a call that may never run.
  const callbackOfRegisteredDescribe = (fn: Node | undefined): boolean => {
    if (fn === undefined || !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
      return false;
    }
    // The LAST argument is the body (a function-valued label never runs),
    // and only a plain synchronous function body registers synchronously.
    if (fn.isAsync() || (Node.isFunctionExpression(fn) && fn.isGenerator())) return false;
    const outer = fn.getParent();
    return (
      Node.isCallExpression(outer) &&
      outer.getArguments().at(-1) === fn &&
      registers(outer, "describe") &&
      registered(outer)
    );
  };
  const registered = (call: CallExpression): boolean => {
    const parent = call.getParent();
    if (Node.isExpressionStatement(parent)) {
      const container = parent.getParent();
      if (Node.isSourceFile(container)) return true;
      if (!Node.isBlock(container)) return false;
      // A `return` earlier in the same callback (bare or conditional) may
      // make the call unreachable: any return whose function is this
      // callback, in a statement before ours, rejects.
      const callback = container.getParent();
      const siblings = container.getStatements();
      const before = siblings.slice(0, siblings.indexOf(parent));
      const returnsEarly = before.some((statement) =>
        [
          ...(Node.isReturnStatement(statement) ? [statement] : []),
          ...statement.getDescendantsOfKind(SyntaxKind.ReturnStatement),
        ].some(
          (ret) =>
            ret.getFirstAncestor(
              (a) =>
                Node.isArrowFunction(a) ||
                Node.isFunctionExpression(a) ||
                Node.isFunctionDeclaration(a) ||
                Node.isMethodDeclaration(a),
            ) === callback,
        ),
      );
      if (returnsEarly) return false;
      return callbackOfRegisteredDescribe(callback);
    }
    return Node.isArrowFunction(parent) && parent.getBody() === call
      ? callbackOfRegisteredDescribe(parent)
      : false;
  };
  const testCalls = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => registers(call, "test") && registered(call));
  if (testCalls.length === 0) {
    return "no enabled test() call (a .skip or .todo, a conditional, or an uncalled function does not count)";
  }
  const valueNames = (node: Node) => new Set(valueIdentifiers(node));
  // Reachability from the tests through top-level helpers, to a fixpoint:
  // test -> invoke -> apply -> rung is a legitimate shape.
  const helpers = new Map<string, Set<string>>();
  for (const fn of file.getFunctions()) {
    const name = fn.getName();
    if (name !== undefined) helpers.set(name, valueNames(fn));
  }
  for (const d of file.getVariableDeclarations()) helpers.set(d.getName(), valueNames(d));
  const reached = new Set(testCalls.flatMap((call) => [...valueNames(call)]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, names] of helpers) {
      if (!reached.has(name)) continue;
      for (const inner of names) {
        if (!reached.has(inner)) {
          reached.add(inner);
          grew = true;
        }
      }
    }
  }
  // The rung must be EXERCISED: a call of `<rung>.apply(...)` on the
  // import or on a binding assigned from it (`const typed: Rung = rung`),
  // sitting inside an enabled test or inside a top-level helper a test
  // reaches - so `void rung` or `rung.id` alone, or an apply call in a
  // function nothing calls, cannot stand in for a test.
  const aliases = new Set([local]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const declaration of file.getVariableDeclarations()) {
      const initializer = declaration.getInitializer();
      if (initializer === undefined) continue;
      const source = unwrapExpression(initializer);
      if (
        Node.isIdentifier(source) &&
        aliases.has(source.getText()) &&
        !aliases.has(declaration.getName())
      ) {
        aliases.add(declaration.getName());
        grew = true;
      }
    }
  }
  const exercised = file.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const callee = call.getExpression();
    if (
      !Node.isPropertyAccessExpression(callee) ||
      callee.getName() !== "apply" ||
      !Node.isIdentifier(callee.getExpression()) ||
      !aliases.has(callee.getExpression().getText())
    ) {
      return false;
    }
    const ancestors = call.getAncestors();
    if (ancestors.some((a) => Node.isCallExpression(a) && testCalls.includes(a))) return true;
    // The top-level statement holding the call: a helper a test reaches.
    const top = ancestors.find((a) => Node.isSourceFile(a.getParent()));
    if (top === undefined) return false;
    if (Node.isFunctionDeclaration(top)) return reached.has(top.getName() ?? "");
    if (Node.isVariableStatement(top)) {
      return top.getDeclarations().some((d) => reached.has(d.getName()));
    }
    return false;
  });
  return exercised
    ? null
    : `no enabled test() reaches a call of ${local}.apply(...) (the rung must be exercised from a test, not merely named)`;
}

/** The ladder's single-source checks (docs/migrations.md has the contract):
 *  rung files only, each `mNNNN_<slug>.ts` default-exporting a rung whose id
 *  is its filename, every rung with a bound unit test, an upgrade-path
 *  harness case, and a docs mention, and no id-shaped token in the docs
 *  naming a rung that does not exist. Drift guards over text and AST
 *  anchors, the threat model every rule in this file shares: an honest edit
 *  that forgets a site goes red; an author with commit rights who writes a
 *  decoy to satisfy the anchors is review's problem. */
export function migrationLadderMismatches(input: {
  /** Ladder directory entry -> source. */
  rungFiles: Record<string, string>;
  /** Test file name -> source, for tests/sync/migrations/. */
  testFiles: Record<string, string>;
  /** The rung ids the upgrade-path harness leaves pending in its synthetic
   *  old build (the keys of PENDING_RUNGS in MIGRATIONS_HARNESS_REL). */
  pendingRungs: readonly string[];
  doc: string;
}): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const ids: string[] = [];
  for (const name of Object.keys(input.rungFiles).sort()) {
    const rel = `${MIGRATIONS_DIR_REL}/${name}`;
    const match = RUNG_FILE_RE.exec(name);
    if (match === null) {
      mismatches.push({ file: rel, expected: "a rung file named mNNNN_<slug>.ts", got: name });
      continue;
    }
    const id = match[1];
    ids.push(id);
    const rung = rungExport(input.rungFiles[name]);
    if (rung?.id !== id) {
      mismatches.push({
        file: rel,
        expected: `export default { id: "${id}", apply } (the id is the filename)`,
        got:
          rung === null
            ? "no default-exported object literal with a string id and an apply member"
            : `id: "${rung.id}"`,
      });
    }
  }
  const testStems = Object.keys(input.testFiles)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => name.slice(0, -".test.ts".length));
  for (const id of ids) {
    const rel = `${MIGRATIONS_TESTS_REL}/${id}.test.ts`;
    if (!testStems.includes(id)) {
      mismatches.push({ file: rel, expected: `a unit test file for migration ${id}`, got: "none" });
      continue;
    }
    // A file alone proves nothing: it must import its rung object and
    // reach it from an enabled test, or a placeholder would satisfy this.
    const shortfall = rungTestShortfall(input.testFiles[`${id}.test.ts`], id);
    if (shortfall !== null) {
      mismatches.push({
        file: rel,
        expected: `a bun:test test() reaching the default import from "${rungTestSpecifier(id)}"`,
        got: shortfall,
      });
    }
  }
  for (const stem of testStems) {
    if (!ids.includes(stem)) {
      mismatches.push({
        file: `${MIGRATIONS_TESTS_REL}/${stem}.test.ts`,
        expected: `test files only for the rungs on the ladder [${ids.join(", ")}]`,
        got: `a test for ${stem}, which has no rung file`,
      });
    }
  }
  // The docs' pruned list (everything under the PRUNED_HEADING up to the
  // next heading) keeps the ids of rungs deleted from main, so a number is
  // never reused: an id there may not be a rung file.
  const prunedAt = input.doc.indexOf(`\n${PRUNED_HEADING}\n`);
  if (prunedAt === -1) {
    mismatches.push({
      file: MIGRATIONS_DOC_REL,
      expected: `a "${PRUNED_HEADING}" section (the ledger of numbers never to reuse)`,
      got: "none",
    });
  }
  const prunedEnd =
    prunedAt === -1 ? -1 : input.doc.indexOf("\n## ", prunedAt + PRUNED_HEADING.length + 1);
  const prunedText =
    prunedAt === -1 ? "" : input.doc.slice(prunedAt, prunedEnd === -1 ? undefined : prunedEnd);
  const listedText =
    prunedAt === -1
      ? input.doc
      : input.doc.slice(0, prunedAt) + (prunedEnd === -1 ? "" : input.doc.slice(prunedEnd));
  // A rung's harness case is its PENDING_RUNGS entry: the harness removes the
  // rung file from its synthetic old build and plants the pre-transition
  // shape, so every update from that build runs the rung. An entry for a
  // rung that has no file would fail the harness at build time; it is red
  // here first.
  for (const id of ids) {
    if (!input.pendingRungs.includes(id)) {
      mismatches.push({
        file: MIGRATIONS_HARNESS_REL,
        expected: `an upgrade-path harness case for migration ${id} (a PENDING_RUNGS entry planting its pre-transition shape)`,
        got: "none",
      });
    }
  }
  for (const id of input.pendingRungs) {
    if (!ids.includes(id)) {
      mismatches.push({
        file: MIGRATIONS_HARNESS_REL,
        expected: `PENDING_RUNGS entries only for the rungs on the ladder [${ids.join(", ")}]`,
        got: `an entry for ${id}, which has no rung file`,
      });
    }
  }
  const docTokens = migrationIdTokens(listedText);
  for (const id of ids) {
    if (!docTokens.has(id)) {
      mismatches.push({
        file: MIGRATIONS_DOC_REL,
        expected: `a docs mention naming migration ${id}`,
        got: "none",
      });
    }
  }
  // Outside the pruned list any other id-shaped token names a rung that
  // does not exist: a typo, or a rung deleted from main without moving its
  // line.
  for (const token of migrationIdTokens(listedText)) {
    if (!ids.includes(token)) {
      mismatches.push({
        file: MIGRATIONS_DOC_REL,
        expected: `mentions only of the rungs on the ladder [${ids.join(", ")}] outside the pruned list`,
        got: `a mention of ${token}, which has no rung file`,
      });
    }
  }
  // Numbers are never reused: not between two live rungs, and not after a
  // pruned rung gave its number up.
  const numberOf = (id: string) => id.slice(1, 5);
  const seen = new Map<string, string>();
  for (const id of ids) {
    const earlier = seen.get(numberOf(id));
    if (earlier !== undefined) {
      mismatches.push({
        file: `${MIGRATIONS_DIR_REL}/${id}.ts`,
        expected: "a rung number no other rung uses",
        got: `${numberOf(id)}, which ${earlier} already uses`,
      });
    } else {
      seen.set(numberOf(id), id);
    }
  }
  for (const token of migrationIdTokens(prunedText)) {
    const live = seen.get(numberOf(token));
    if (live !== undefined) {
      mismatches.push({
        file: `${MIGRATIONS_DIR_REL}/${live}.ts`,
        expected: "a rung number no pruned rung ever used (numbers are never reused)",
        got: `${numberOf(token)}, which the pruned rung ${token} in ${MIGRATIONS_DOC_REL} used`,
      });
    }
  }
  return mismatches;
}

/** The specifiers a rung may import: node builtins and bun's own modules,
 *  minus `node:module` (a loader factory - createRequire - is the one
 *  builtin that reaches outside). A rung runs from whichever build commit
 *  carries it, where no sibling script, shared helper, or package exists. */
const SELF_CONTAINED_SPECIFIER_RE = /^(?:node:(?!module$)|bun:)/;

/** Every module specifier a rung file names - static imports (type-only
 *  included: the rule is about the file's shape, not what survives
 *  erasure), re-exports, `import x = require()`, `import("...")` type
 *  nodes, `import()` and `require()` calls - and whether it is allowed. A
 *  non-literal specifier is a mismatch, and so is any other reach for a
 *  loader: `require` or `module` named anywhere but as the inspected
 *  callee. A syntactic scan, on purpose: an author with commit rights who
 *  smuggles a loader past it is review's problem, an honest slip is not. */
export function selfContainedMismatches(rungFiles: Record<string, string>): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const expected =
    "imports of node:/bun: specifiers only (a rung runs from its build commit, where nothing else exists)";
  const literalOf = (node: Node | undefined): string | null =>
    node !== undefined && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
      ? node.getLiteralValue()
      : null;
  for (const [name, source] of Object.entries(rungFiles)) {
    const rel = `${MIGRATIONS_DIR_REL}/${name}`;
    const file = parseTs(source);
    const specifiers: string[] = [
      ...file.getImportDeclarations().map((decl) => decl.getModuleSpecifierValue()),
      ...file
        .getExportDeclarations()
        .map((decl) => decl.getModuleSpecifierValue())
        .filter((value): value is string => value !== undefined),
    ];
    const nonLiteral = (what: string) =>
      mismatches.push({ file: rel, expected, got: `${what} of a non-literal specifier` });
    for (const decl of file.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
      const reference = decl.getModuleReference();
      const literal = Node.isExternalModuleReference(reference)
        ? literalOf(reference.getExpression())
        : null;
      if (literal === null) nonLiteral("import-equals");
      else specifiers.push(literal);
    }
    for (const node of file.getDescendantsOfKind(SyntaxKind.ImportType)) {
      const argument = node.getArgument();
      const literal = Node.isLiteralTypeNode(argument) ? literalOf(argument.getLiteral()) : null;
      if (literal === null) nonLiteral("import type");
      else specifiers.push(literal);
    }
    const inspectedCallees = new Set<Node>();
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const dynamic =
        callee.getKind() === SyntaxKind.ImportKeyword ||
        (Node.isIdentifier(callee) && callee.getText() === "require");
      if (!dynamic) continue;
      inspectedCallees.add(callee);
      const literal = literalOf(call.getArguments()[0]);
      if (literal === null) nonLiteral(`${callee.getText()}()`);
      else specifiers.push(literal);
    }
    for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const text = identifier.getText();
      if ((text !== "require" && text !== "module") || inspectedCallees.has(identifier)) continue;
      mismatches.push({ file: rel, expected, got: `a reach for the loader through \`${text}\`` });
    }
    for (const specifier of specifiers) {
      if (!SELF_CONTAINED_SPECIFIER_RE.test(specifier)) {
        mismatches.push({ file: rel, expected, got: `an import of "${specifier}"` });
      }
    }
  }
  return mismatches;
}

export interface RetiredShape {
  readonly name: string;
  /** Matches one occurrence in a line; anchored to whole tokens. */
  readonly re: RegExp;
  /** Text that trips the pattern, for the rule's own control. */
  readonly sample: string;
  /** What moved the fleet off the shape: the rung, or the census that stood in for one. */
  readonly retiredBy: string;
  /** A manifest entry body spelling the token, for the validator's control that such an entry
   *  draws an error naming the entry and the token; absent for tokens that never rode the
   *  manifest. */
  readonly manifestEntry?: string;
}

const bounded = (token: string, retiredBy: string, manifestEntry?: string): RetiredShape => ({
  name: token,
  re: new RegExp(
    `(?<![A-Za-z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
  ),
  sample: token,
  retiredBy,
  ...(manifestEntry === undefined ? {} : { manifestEntry }),
});

const splitEntry = (grammar: string, extraField?: string): string =>
  `{"class": "split", "grammar": ${JSON.stringify(grammar)}, "begin": "# b", "end": "# e"` +
  `${extraField === undefined ? "" : `, ${JSON.stringify(extraField)}: "# x"`}, "hash": null}`;

const ONE_GRAMMAR =
  "the collapse of the two split grammars into managed-region; no rung: the one-shot conversion had crossed every repository (census)";

const SECURITY_RUNG = "m0001_security_policy_to_github, the rung that replaced the one-shot script";

const SETTINGS_STARTER =
  "settings.yml becoming a starter with its baseline computed centrally; no rung: every render restamps the manifest";

const LICENSE_CENSUS =
  "the fleet LICENSE.md rename; no rung: every managed repository carried LICENSE.md (census)";

const ALL_GREEN_INVERSION =
  "the all-green inversion: the gate became the all-green action's verdict check run; no rung: copier re-renders ci.yml (census: every render on the single-call shape)";

/** Identifying tokens of retired shapes, one line each with what retired it (docs/migrations.md).
 *  A tripwire for the audited shapes, not a proof of the policy: a new tolerance needs a new line;
 *  the class token matches a class VALUE only, so a gh `--json mergeable` field stays legal. */
export const RETIRED_SHAPE_TOKENS: readonly RetiredShape[] = [
  bounded("tail-marker", ONE_GRAMMAR, splitEntry("tail-marker")),
  bounded("bounded-region", ONE_GRAMMAR, splitEntry("bounded-region")),
  bounded("repo-platform:local-section", ONE_GRAMMAR),
  bounded("REPOSITORY LOCAL", ONE_GRAMMAR),
  bounded("managed_end", ONE_GRAMMAR, splitEntry("managed-region", "managed_end")),
  bounded("local_begin", ONE_GRAMMAR, splitEntry("managed-region", "local_begin")),
  bounded("local_end", ONE_GRAMMAR, splitEntry("managed-region", "local_end")),
  bounded("pre-grammar", ONE_GRAMMAR),
  bounded("relocate_security_policy", SECURITY_RUNG),
  bounded("security-move.md", SECURITY_RUNG),
  {
    name: "the mergeable ownership class",
    re: /\bclass\b[^\n]{0,8}?["']mergeable["']/,
    sample: 'class: "mergeable"',
    retiredBy: SETTINGS_STARTER,
    manifestEntry: '{"class": "mergeable"}',
  },
  {
    name: "the two license spellings",
    re: /["'`]LICENSE["'`]\s*,\s*["'`]LICENSE\.md["'`]/,
    sample: '"LICENSE", "LICENSE.md"',
    retiredBy: LICENSE_CENSUS,
  },
  bounded("All jobs green", ALL_GREEN_INVERSION),
  bounded("judgesInline", ALL_GREEN_INVERSION),
];

/** The no-retired-shapes scan set. Exempt: the ladder and its tests (a rung exists to name the
 *  shape it moves repositories off), the token list's own file, and its planted controls. */
export const RETIRED_SHAPE_SCAN = {
  dirs: [".github/scripts", ".github/workflows", "actions", "scripts", "templates", "tests"],
  files: ["copier.yml"],
  exempt: [
    MIGRATIONS_DIR_REL,
    MIGRATIONS_TESTS_REL,
    "scripts/check/ssot/migration_ladder.ts",
    "tests/scripts/migration_ladder_rule.test.ts",
  ],
};

/** Whether `rel` is an exempt path or lies under an exempt directory. */
export function retiredShapeExempt(rel: string): boolean {
  return RETIRED_SHAPE_SCAN.exempt.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
}

/** The first retired-shape occurrence on each line that carries one
 *  (file:line, the matched text). */
export function retiredShapeMismatches(files: Record<string, string>): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const [rel, text] of Object.entries(files)) {
    text.split("\n").forEach((line, index) => {
      for (const shape of RETIRED_SHAPE_TOKENS) {
        const match = shape.re.exec(line);
        if (match === null) continue;
        mismatches.push({
          file: `${rel}:${index + 1}`,
          expected:
            "no identifying token of a retired shape outside the migration ladder (no compatibility code outside the ladder; a transition is a rung)",
          got: match[0],
        });
        break;
      }
    });
  }
  return mismatches;
}

/** Every entry of the ladder directory with its source (no filter: a
 *  stray non-rung file must be judged too). */
export function rungSources(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(join(REPO_ROOT, MIGRATIONS_DIR_REL)).map((name) => [
      name,
      read(`${MIGRATIONS_DIR_REL}/${name}`),
    ]),
  );
}

/** The no-retired-shapes scan set as repo-relative path -> text. */
export function retiredShapeScanFiles(): Record<string, string> {
  const paths = [
    ...RETIRED_SHAPE_SCAN.files,
    ...RETIRED_SHAPE_SCAN.dirs.flatMap((dir) =>
      walkFiles(dir)
        .filter((entry) => !entry.symlink)
        .map((entry) => entry.path),
    ),
  ].filter((rel) => !retiredShapeExempt(rel));
  return Object.fromEntries(paths.map((rel) => [rel, read(rel)]));
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const migrationLadderRules: Rule[] = [
  {
    // The migration ladder's single sources (migrationLadderMismatches
    // has the model): rung files only in the ladder directory, each id
    // its filename, every rung with a bound unit test, a harness case,
    // and a docs mention, and no docs mention of a rung that does not
    // exist.
    name: "migration-ladder",
    run: () =>
      migrationLadderMismatches({
        rungFiles: rungSources(),
        testFiles: Object.fromEntries(
          readdirSync(join(REPO_ROOT, MIGRATIONS_TESTS_REL)).map((name) => [
            name,
            read(`${MIGRATIONS_TESTS_REL}/${name}`),
          ]),
        ),
        pendingRungs: Object.keys(PENDING_RUNGS),
        doc: read(MIGRATIONS_DOC_REL),
      }),
  },
  {
    // A rung runs from whichever build commit carries it, with no
    // siblings, shared helpers, or packages beside it: node:/bun:
    // specifiers only (selfContainedMismatches has the model).
    name: "migrations-self-contained",
    run: () => selfContainedMismatches(rungSources()),
  },
  {
    // No compatibility code outside the migration ladder: the identifying
    // tokens of the shapes the platform once tolerated (RETIRED_SHAPE_TOKENS)
    // appear nowhere in the sync, the actions, the scripts, the template
    // sources, or their tests.
    name: "no-retired-shapes",
    run: () => retiredShapeMismatches(retiredShapeScanFiles()),
  },
];
