// Rules over process hygiene in the executable trees: bounded spawnSync,
// temp dirs through the shared helper, no tests beside actions, and
// synchronous stream writes.

import {
  type CallExpression,
  type Expression,
  Node,
  type PropertyAccessExpression,
  SyntaxKind,
} from "ts-morph";
import {
  parseTs,
  rootIdentifier,
  syntaxErrorCount,
  unwrapExpression,
} from "../../lib/ts_extract.ts";
import type { Mismatch } from "./comparison.ts";
import { read, walkFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The single expression `text` parses to (wrapping parentheses
 *  unwrapped), or null when it is not a lone, clean expression - the
 *  shared entry for reading option and stdio literals structurally. */
function parsedExpression(text: string): Expression | null {
  const wrapped = `(${text});`;
  if (syntaxErrorCount(wrapped) > 0) return null; // recovered nodes are unauditable
  const statements = parseTs(wrapped).getStatements();
  const statement = statements.length === 1 ? statements[0] : undefined;
  if (statement === undefined || !Node.isExpressionStatement(statement)) return null;
  return unwrapExpression(statement.getExpression());
}

/** The top-level properties of an options OBJECT LITERAL: property name
 *  -> initializer text (a shorthand property maps to its own name),
 *  read off the parsed literal, so a comma or colon inside a nested
 *  value or a string can never split or fake a property. Null when the
 *  text is not an auditable literal - a variable, a call result, a
 *  top-level spread, a method, a computed or non-identifier-shaped key
 *  - which the caller treats as a hazard, so the unreadable shapes fail
 *  closed. */
export function topLevelProperties(options: string): Map<string, string> | null {
  const text = options.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const literal = parsedExpression(text);
  if (literal === null || !Node.isObjectLiteralExpression(literal)) return null;
  const props = new Map<string, string>();
  for (const property of literal.getProperties()) {
    if (Node.isShorthandPropertyAssignment(property)) {
      props.set(property.getName(), property.getName());
      continue;
    }
    if (!Node.isPropertyAssignment(property)) return null; // a spread, a method - unauditable
    const nameNode = property.getNameNode();
    const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText();
    if (
      !(Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode)) ||
      !/^[A-Za-z_$][\w$]*$/.test(name)
    ) {
      return null; // a computed or exotic key - unauditable
    }
    const value = property.getInitializer()?.getText().trim();
    if (value === undefined || value === "") return null;
    props.set(name, value);
  }
  return props;
}

/** A stdio value's shape, decided on the PARSED expression (wrapping
 *  parentheses and type dressing unwrap first, so `(["pipe"])` is still
 *  the array it is): slot texts for a spread-free array literal (an
 *  elided slot reads as empty), unauditable for a spread-carrying array
 *  or unparsable text (a spread can shift or inject stream slots), and
 *  scalar for everything else (a named constant, trusted by its key
 *  like other variable values). */
function stdioShape(
  text: string,
): { kind: "slots"; slots: string[] } | { kind: "unauditable" } | { kind: "scalar" } {
  const literal = parsedExpression(text);
  if (literal === null) return { kind: "unauditable" };
  if (!Node.isArrayLiteralExpression(literal)) return { kind: "scalar" };
  const elements = literal.getElements();
  if (elements.some(Node.isSpreadElement)) return { kind: "unauditable" };
  return {
    kind: "slots",
    slots: elements.map((element) =>
      Node.isOmittedExpression(element) ? "" : element.getText().trim(),
    ),
  };
}

// A GLOBAL receiver (Bun, process), shared by the spawn and stream-write
// scans and hardened against decorative spellings: parentheses, the TS
// non-null `!`, and type-only wrappers unwrap to the same receiver, and a
// property access ENDING in the global's name (globalThis.Bun) counts too,
// since over-matching someone else's `.Bun` is the loud direction.
// Identifier names match EXACTLY, so a look-alike like `fakeprocess` is not
// the global. The recorded residual: an alias of the global itself (`const b
// = Bun; b.spawnSync(...)`), which nothing in house style writes.
function isGlobalReceiver(expression: Expression, name: string): boolean {
  const node = unwrapExpression(expression);
  if (Node.isIdentifier(node)) return node.getText() === name;
  return Node.isPropertyAccessExpression(node) && node.getName() === name;
}

/** Whether a property-name text names spawnSync as a whole word - the
 *  destructure scans' test, so a computed spelling (["spawnSync"], or a
 *  variable named spawnSync) fails closed exactly like the plain key. */
function namesSpawnSync(nameText: string): boolean {
  return /(^|[^\w$])spawnSync([^\w$]|$)/.test(nameText) || nameText === "spawnSync";
}

/** The CallExpression `node` is the callee of (parentheses and non-null
 *  wrappers between them unwrapped), or null when the access is not
 *  directly called - `f(Bun.spawnSync)` passes it as a value, and
 *  `Bun.spawnSync.call(...)` calls a DIFFERENT member off it. */
function enclosingCall(node: Node): CallExpression | null {
  let current: Node = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) return null;
    if (Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent)) {
      current = parent;
      continue;
    }
    return Node.isCallExpression(parent) && parent.getExpression() === current ? parent : null;
  }
}

/** A spawnSync occurrence in parsed source: a direct `Bun.spawnSync`
 *  call with its options text, or any other reference - an alias, a
 *  destructure pulling spawnSync off Bun, bracket access - a sum, so
 *  the rule cannot forget to judge the non-call shapes. */
export type SpawnSyncSite =
  | { line: number; kind: "call"; options: string | null }
  | { line: number; kind: "reference" };

/** The options argument's text for a direct spawnSync call: the second
 *  argument, the whole argument list for the object-form overload
 *  (whose options ride beside `cmd`; extra arguments keep riding along
 *  so topLevelProperties refuses the unauditable shape), or null when
 *  the call passes the command alone. */
function spawnOptionsText(call: CallExpression): string | null {
  const args = call.getArguments();
  if (args.length === 0) return null;
  if (Node.isObjectLiteralExpression(args[0])) {
    return args.map((argument) => argument.getText()).join(", ");
  }
  if (args.length === 1) return null;
  return args
    .slice(1)
    .map((argument) => argument.getText())
    .join(", ");
}

/** Every spawnSync site in a source file, read off the AST (a mention in a
 *  comment, string, or regex body is not a node; a template INTERPOLATION is
 *  code and is). A direct call, plain, optional, or re-punctuated, carries
 *  its options argument's text. Everything else is a reference the rule
 *  fails closed: a bare `Bun.spawnSync` (an alias binding, `.call`), a
 *  destructure pulling spawnSync off Bun, and ANY computed access on Bun,
 *  whose property expression can spell spawnSync any way it likes. */
export function spawnSyncSites(source: string, where: string): SpawnSyncSite[] {
  // A file the parser had to RECOVER must not be judged: a truncated
  // call's recovered options can read as a benign shape, so the scan
  // throws instead of passing vacuously (the old lexer's contract).
  if (syntaxErrorCount(source) > 0) {
    throw new Error(`${where}: source has syntax errors - the spawn scan cannot audit it`);
  }
  const sites: SpawnSyncSite[] = [];
  for (const node of parseTs(source).forEachDescendantAsArray()) {
    if (
      Node.isPropertyAccessExpression(node) &&
      node.getName() === "spawnSync" &&
      isGlobalReceiver(node.getExpression(), "Bun")
    ) {
      const line = node.getStartLineNumber();
      const call = enclosingCall(node);
      if (call === null) sites.push({ line, kind: "reference" });
      else sites.push({ line, kind: "call", options: spawnOptionsText(call) });
      continue;
    }
    if (Node.isElementAccessExpression(node) && isGlobalReceiver(node.getExpression(), "Bun")) {
      sites.push({ line: node.getStartLineNumber(), kind: "reference" });
      continue;
    }
    // The destructure shapes: `const { spawnSync } = Bun` (a binding
    // pattern, parameter defaults included) and `({ spawnSync } = Bun)`
    // (an assignment target). The initializer counts when its ROOT
    // identifier is Bun (`= Bun.anything` fails closed too) or when it
    // is the global receiver itself in any spelling (globalThis.Bun).
    if (Node.isObjectBindingPattern(node)) {
      const owner = node.getParent();
      const initializer =
        Node.isVariableDeclaration(owner) || Node.isParameterDeclaration(owner)
          ? owner.getInitializer()
          : undefined;
      const pulls = node
        .getElements()
        .some((element) =>
          namesSpawnSync((element.getPropertyNameNode() ?? element.getNameNode()).getText()),
        );
      if (
        pulls &&
        initializer !== undefined &&
        (rootIdentifier(initializer) === "Bun" || isGlobalReceiver(initializer, "Bun"))
      ) {
        sites.push({ line: node.getStartLineNumber(), kind: "reference" });
      }
      continue;
    }
    if (
      Node.isBinaryExpression(node) &&
      node.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    ) {
      const left = unwrapExpression(node.getLeft());
      const pulls =
        Node.isObjectLiteralExpression(left) &&
        left
          .getProperties()
          .some(
            (property) =>
              (Node.isShorthandPropertyAssignment(property) ||
                Node.isPropertyAssignment(property)) &&
              namesSpawnSync(property.getNameNode().getText()),
          );
      if (
        pulls &&
        (rootIdentifier(node.getRight()) === "Bun" || isGlobalReceiver(node.getRight(), "Bun"))
      ) {
        sites.push({ line: node.getStartLineNumber(), kind: "reference" });
      }
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

/** Why a spawnSync call is an unbounded piped hazard, or null when safe. Measured on the
 *  pinned bun: a PIPED sync spawn without an effective `timeout` returns at pipe EOF, not
 *  child exit, so a descendant holding the inherited pipe fds wedges the caller, and a bare
 *  call pipes BOTH streams. Safe: a top-level `timeout` that is a positive finite numeric
 *  literal or a plain identifier/member path, or every output stream explicitly non-"pipe";
 *  unprovable shapes (an expression, nested options, unparsable text) fail closed. Variable
 *  VALUES are trusted by their key (rejecting identifiers would red proc.ts's own shorthand
 *  `timeout` option), so a variable smuggling "pipe" or zero escapes: the recorded residual. */
export function spawnSyncHazard(options: string | null): string | null {
  if (options === null) {
    return "no options - stdout and stderr pipe by default, and nothing bounds a pipe-holding descendant";
  }
  const props = topLevelProperties(options);
  if (props === null) {
    return "options the scanner cannot audit (a variable, a spread, or a non-literal shape)";
  }
  const timeout = props.get("timeout");
  let bounded = false;
  if (timeout !== undefined && !["undefined", "null", "NaN", "Infinity"].includes(timeout)) {
    // Numeric-separator spellings (10_000) are literals too - strip the
    // separators before folding, so a bounded call does not misread as
    // unprovable (and every separator spelling of zero still folds to 0).
    const n = Number(timeout.replaceAll("_", ""));
    // Number() folds every numeric spelling of zero (0, 0.0, 0x0, 0e0,
    // -0, +0) onto 0; a non-numeric value only counts when it is a plain
    // identifier or member path - an expression can evaluate to zero
    // (`1 - 1`) and is unprovable, so it fails closed.
    bounded = Number.isNaN(n)
      ? /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(timeout)
      : Number.isFinite(n) && n > 0;
  }
  if (bounded) return null;
  const why = timeout === undefined ? "no timeout" : `timeout: ${timeout} is not a provable bound`;
  const pipes = (value: string | undefined) => value !== undefined && /["'`]pipe["'`]/.test(value);
  if (pipes(props.get("stdio")) || pipes(props.get("stdout")) || pipes(props.get("stderr"))) {
    return `explicitly piped stdio with ${why}`;
  }
  const unset = (value: string | undefined) =>
    value === undefined || value === "" || value === "undefined" || value === "null";
  // A stdio ARRAY literal shapes each stream through its own slot
  // (1 = stdout, 2 = stderr): an omitted, elided, or undefined/null slot
  // leaves that stream on the piped default. A non-array stdio value (a
  // named constant) is trusted by its key, like other variable values.
  const stdio = props.get("stdio");
  const stdioTrimmed = stdio?.trim();
  const shape = stdioTrimmed === undefined ? { kind: "scalar" as const } : stdioShape(stdioTrimmed);
  if (shape.kind === "unauditable") {
    return `a stdio value the scanner cannot audit (a spread or non-literal shape) with ${why}`;
  }
  const slots = shape.kind === "slots" ? shape.slots : null;
  const shaped = (stream: "stdout" | "stderr", slot: number) => {
    const viaStdio = slots !== null ? slots[slot] : stdioTrimmed;
    return !unset(viaStdio) || !unset(props.get(stream));
  };
  const unshaped = (["stdout", "stderr"] as const).filter(
    (stream, index) => !shaped(stream, index + 1),
  );
  if (unshaped.length > 0) {
    return `${unshaped.join(" and ")} left to the piped default with ${why}`;
  }
  return null;
}

// ASYNC Bun.spawn is a different hazard model, judged as an EXACT-SET
// enumeration rather than the sync rule's bounded-or-unpiped bar: an async
// site draining both pipes has no pipe-EOF deadlock to bound and no
// `timeout` option to pin, so every file calling Bun.spawn appears here with
// the rationale that bounds it. The set pins NAMES, not a count: a bounded
// spawnSync rewritten as async would EXIT the sync gate silently, reading as
// an improvement, so the laundering must fail by introducing a name this pin
// does not carry. Residual: an alias of Bun escapes both scans, Bun["spawn"] this one.
export const ASYNC_SPAWN_FILES: Record<string, string> = {
  "actions/fuzz-issue/fuzz-issue.ts":
    "gh runner draining both pipes concurrently under Promise.all; bounded by the GitHub job timeout",
  "actions/release-health/release-health.ts":
    "gh runner draining both pipes concurrently under Promise.all; bounded by the GitHub job timeout",
  "tests/build-branches/publish_behavior.test.ts":
    "one publish.ts child runs in the background, parked inside a PATH-stubbed rsync while a " +
    "second publish runs to completion in the foreground; a timer SIGKILLs the child at " +
    "SPAWN_TIMEOUT_MS, the stub bounds its own wait, and a killed child throws instead of " +
    "yielding an outcome",
  "scripts/run_tests.ts":
    "the test launcher forwards SIGINT/SIGTERM/SIGHUP to its bun test child, fails a run that left entries in the per-run TMPDIR, and removes that TMPDIR after the child exits; inherited stdio, so no pipe to drain, bounded by the child's own life",
};

/** The exact-set judgment for one file's async Bun.spawn mentions
 *  (property accesses on the Bun receiver, read off the AST, so
 *  comments and strings never count, `spawn` cannot match inside
 *  spawnSync, and a re-punctuated callee - `(Bun).spawn`, `Bun!.spawn`
 *  - is still a site). An unenumerated file with any site fails per
 *  site; an enumerated file with none left is a stale entry - the set
 *  stays exact in both directions. */
export function asyncSpawnMismatches(rel: string, source: string, enumerated: boolean): Mismatch[] {
  if (syntaxErrorCount(source) > 0) {
    throw new Error(`${rel}: source has syntax errors - the spawn scan cannot audit it`);
  }
  const lines = parseTs(source)
    .forEachDescendantAsArray()
    .filter(
      (node): node is PropertyAccessExpression =>
        Node.isPropertyAccessExpression(node) &&
        node.getName() === "spawn" &&
        isGlobalReceiver(node.getExpression(), "Bun"),
    )
    .map((node) => node.getStartLineNumber());
  if (!enumerated) {
    return lines.map((line) => ({
      file: `${rel}:${line}`,
      expected:
        "no async Bun.spawn outside ASYNC_SPAWN_FILES (async sites are deadline-or-enumerated: " +
        "no timeout option exists there, so each site's bound is a recorded rationale; a sync " +
        "site rewritten async exits the sync gate and must land here, by name)",
      got: "an unenumerated async Bun.spawn",
    }));
  }
  if (lines.length === 0) {
    return [
      {
        file: rel,
        expected: "an async Bun.spawn call (the ASYNC_SPAWN_FILES entry's subject)",
        got: "none - stale enumeration entry; remove it",
      },
    ];
  }
  return [];
}

/** The one file allowed to call mkdtemp in the test trees: the fixture
 *  owner whose afterAll removes what it made. */
export const TEMP_DIR_HELPER = "tests/shared/temp_dir.ts";

/** A file `bun test` discovers and runs: `.test`, `_test`, `.spec`, or
 *  `_spec` before a script extension. Measured on bun 1.4.0: the .mts,
 *  .cts, and .mjs spellings run too, beyond the four the docs list; JSX
 *  variants are included (none exist here, and one would fail the parse
 *  loudly rather than escape). */
export const BUN_TEST_FILE = /[._](test|spec)\.[mc]?[jt]sx?$/;

const SCRIPT_FILE = /\.[mc]?[jt]sx?$/;

/** Every mkdtemp identifier in a source file, one entry per identifier,
 *  read off the AST: a named import (`mkdtempSync`, `mkdtemp`, from
 *  node:fs or fs/promises, any alias), a member access (`fs.mkdtempSync`,
 *  `promises.mkdtemp`), a destructure, a bare reference - any Identifier
 *  node spelling either name is a site, so a mention in a comment, a
 *  string, or a template body (the launcher test's generated probe
 *  source) is not one. */
export function mkdtempSites(source: string): number[] {
  return parseTs(source)
    .forEachDescendantAsArray()
    .filter((node) => Node.isIdentifier(node) && /^mkdtemp(Sync)?$/.test(node.getText()))
    .map((node) => node.getStartLineNumber());
}

/** The judgment for one selected file: a symlink fails closed (its
 *  target is not audited in place, wherever it points); otherwise,
 *  outside TEMP_DIR_HELPER no mkdtemp at all, per site; the helper
 *  itself must carry one, or the scan has lost its anchor (the
 *  identifier detection proven against the real call). */
export function tempDirFileMismatches(
  file: { path: string; symlink: boolean },
  source: () => string,
): Mismatch[] {
  if (file.symlink) {
    return [
      {
        file: file.path,
        expected: "a regular file (a symlink's target is not audited in place)",
        got: "a symlink",
      },
    ];
  }
  return tempDirSiteMismatches(file.path, source());
}

/** Selection and judgment for the walked tests/ tree: every script under
 *  it, each judged by tempDirFileMismatches; the helper must be among them
 *  as a regular file, or the anchor is lost. */
export function tempDirTreeMismatches(
  files: { path: string; symlink: boolean }[],
  read: (rel: string) => string,
): Mismatch[] {
  const selected = files.filter((f) => f.path.startsWith("tests/") && SCRIPT_FILE.test(f.path));
  if (!selected.some((f) => f.path === TEMP_DIR_HELPER && !f.symlink)) {
    throw new Error(`${TEMP_DIR_HELPER}: the temp-dir helper is missing - anchor lost`);
  }
  return selected.flatMap((f) => tempDirFileMismatches(f, () => read(f.path)));
}

/** Every file bun test would discover under actions/ is a mismatch: tests
 *  live under tests/actions/<action>/, the launcher's one root is tests/,
 *  and the build tree ships actions without tests (branch_tree.ts). */
export function actionTestFileMismatches(files: { path: string }[]): Mismatch[] {
  return files
    .filter((f) => BUN_TEST_FILE.test(f.path))
    .map((f) => ({
      file: f.path,
      expected:
        "no test file under actions/ (tests live under tests/actions/<action>/, mirroring the action's tree)",
      got: "a bun-discoverable test file beside an action's sources",
    }));
}

export function tempDirSiteMismatches(rel: string, source: string): Mismatch[] {
  const lines = mkdtempSites(source);
  if (rel === TEMP_DIR_HELPER) {
    if (lines.length === 0) {
      throw new Error(`${rel}: no mkdtemp call in the temp-dir helper - anchor lost`);
    }
    return [];
  }
  return lines.map((line) => ({
    file: `${rel}:${line}`,
    expected: `a fixture from ${TEMP_DIR_HELPER} (tempDirs() at the file's top level, then temp.dir(prefix)) - the helper removes it after the file's tests`,
    got: "a bare mkdtemp, which nothing removes when the test fails, throws, or forgets",
  }));
}

/** Async stream-write call sites - `process.stdout.write(...)` and the
 *  stderr twin, optional chaining and decorative wrappers tolerated -
 *  read off the AST, so a mention in a comment, a string, or a regex
 *  body never fires while a template INTERPOLATION's call does. The
 *  residual: an alias of the stream or the method
 *  (`const out = process.stdout; out.write(x)`) escapes - nothing in
 *  house style writes that, and writeSync is the sanctioned route. */
function asyncStreamWriteCalls(source: string): CallExpression[] {
  return parseTs(source)
    .forEachDescendantAsArray()
    .filter((node): node is CallExpression => {
      if (!Node.isCallExpression(node)) return false;
      const callee = unwrapExpression(node.getExpression());
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "write") return false;
      const stream = unwrapExpression(callee.getExpression());
      if (
        !Node.isPropertyAccessExpression(stream) ||
        (stream.getName() !== "stdout" && stream.getName() !== "stderr")
      ) {
        return false;
      }
      return isGlobalReceiver(stream.getExpression(), "process");
    });
}

/** Whether anything exit-capable sits at or after `at`: process.exit
 *  itself (a reference suffices), an uncaught `throw` (the abort path
 *  drains no queued writes either), and calls to the helpers that exit
 *  (gha's fail/requireEnv, proc's must/mustCapture). Lexical order over
 *  a roster, not control-flow proof: a locally defined wrapper around
 *  process.exit called after the write stays a reviewable residual. */
function exitCapableAfter(source: string, at: number): boolean {
  const EXIT_CALLEES = new Set(["fail", "requireEnv", "must", "mustCapture"]);
  return parseTs(source)
    .forEachDescendantAsArray()
    .some((node) => {
      if (node.getStart() < at) return false;
      if (Node.isThrowStatement(node)) return true;
      if (Node.isPropertyAccessExpression(node) && node.getName() === "exit") {
        return isGlobalReceiver(node.getExpression(), "process");
      }
      if (!Node.isCallExpression(node)) return false;
      const callee = unwrapExpression(node.getExpression());
      const name = Node.isIdentifier(callee)
        ? callee.getText()
        : Node.isPropertyAccessExpression(callee)
          ? callee.getName()
          : null;
      return name !== null && EXIT_CALLEES.has(name);
    });
}

/** Files allowed to keep async stream writes because every exit-capable
 *  call precedes the first async write, so the writes ride to a natural
 *  exit, which drains. The reason is EXECUTABLE, not prose:
 *  asyncStreamWriteMismatches re-proves it per entry (nothing exit-capable
 *  may follow the first write) and flags an entry whose file has no async
 *  write left as stale. Empty since open_pr.ts converted its auto-merge
 *  re-emission to writeSync; the mechanism stays fixture-tested in
 *  tests/scripts/check_ssot/process_discipline.test.ts. */
export const NATURAL_EXIT_WRITE_FILES: ReadonlySet<string> = new Set([]);

/** How `source` violates the stream-write-sync contract. An unlisted
 *  file may carry no async stream write at all; an allowlisted file must
 *  still carry one (else the entry is stale) with nothing exit-capable
 *  after the first. */
export function asyncStreamWriteMismatches(
  rel: string,
  source: string,
  allowlisted: boolean,
): Mismatch[] {
  if (syntaxErrorCount(source) > 0) {
    throw new Error(`${rel}: source has syntax errors - the stream-write scan cannot audit it`);
  }
  const first = asyncStreamWriteCalls(source).reduce(
    (earliest: CallExpression | null, call) =>
      earliest === null || call.getStart() < earliest.getStart() ? call : earliest,
    null,
  );
  if (!allowlisted) {
    if (first === null) return [];
    return [
      {
        file: `${rel}:${first.getStartLineNumber()}`,
        expected:
          "writeSync for stream writes (bun's async stream writes truncate at the pipe buffer when any later path exits), or a NATURAL_EXIT_WRITE_FILES entry whose reason holds",
        got: "an async stream write",
      },
    ];
  }
  if (first === null) {
    return [
      {
        file: rel,
        expected: "an async stream write (the NATURAL_EXIT_WRITE_FILES entry's reason)",
        got: "none - stale allowlist entry; remove it",
      },
    ];
  }
  if (exitCapableAfter(source, first.getStart())) {
    return [
      {
        file: rel,
        expected:
          "nothing exit-capable after the first async stream write (the natural-exit reason NATURAL_EXIT_WRITE_FILES encodes)",
        got: "an exit-capable call after it - the write can truncate; convert it to writeSync and drop the entry",
      },
    ];
  }
  return [];
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const processDisciplineRules: Rule[] = [
  {
    // No PIPED Bun spawnSync without a hard `timeout`: on the pinned bun a piped synchronous
    // spawn returns at pipe EOF, not child exit, and pipes both streams by default
    // (spawnSyncHazard has the measured semantics), so one bare git call can wedge a checker
    // forever behind a descendant holding the pipe. tests/** is in scope: a sync spawn blocks
    // the runner, so bun-test's per-test timeout cannot interrupt a hung child, and its 5s
    // hook cap trips on cold starts, so suites carry their own bounds. Tests need stdio/env
    // shapes proc.ts lacks, so its helpers are the remedy, not the bar. actions/ sync spawns
    // are the actions-bun-guard review surface; ASYNC Bun.spawn is judged under ASYNC_SPAWN_FILES.
    name: "spawn-sync-hang-bound",
    run: () => {
      const mismatches: Mismatch[] = [];
      let sites = 0;
      const files = [
        ...walkFiles("scripts"),
        ...walkFiles(".github/scripts"),
        ...walkFiles("tests"),
      ]
        .filter((f) => !f.symlink && /\.[mc]?[jt]s$/.test(f.path))
        .map((f) => f.path);
      for (const rel of files) {
        for (const site of spawnSyncSites(read(rel), rel)) {
          sites++;
          if (site.kind === "reference") {
            mismatches.push({
              file: `${rel}:${site.line}`,
              expected:
                "a direct Bun spawnSync call (an alias or destructure cannot be audited for a hang bound)",
              got: "a non-call reference",
            });
            continue;
          }
          const hazard = spawnSyncHazard(site.options);
          if (hazard !== null) {
            const helper = rel.startsWith("tests/")
              ? "tests/shared/bounded_spawn.ts"
              : ".github/scripts/shared/proc.ts";
            mismatches.push({
              file: `${rel}:${site.line}`,
              expected: `a bounded or unpiped spawnSync: a ${helper} helper, an explicit timeout, or every output stream shaped to inherit/ignore/file fds`,
              got: hazard,
            });
          }
        }
      }
      // The async pass, actions/ included: every Bun.spawn caller must
      // sit in ASYNC_SPAWN_FILES by name (exact set, both directions).
      const asyncFiles = [
        ...files,
        ...walkFiles("actions")
          .filter((f) => !f.symlink && /\.[mc]?[jt]s$/.test(f.path))
          .map((f) => f.path),
      ];
      const asyncPresent = new Set(asyncFiles);
      for (const rel of asyncFiles) {
        mismatches.push(...asyncSpawnMismatches(rel, read(rel), rel in ASYNC_SPAWN_FILES));
      }
      for (const rel of Object.keys(ASYNC_SPAWN_FILES).sort()) {
        if (!asyncPresent.has(rel)) {
          mismatches.push({
            file: rel,
            expected: "a scanned file (ASYNC_SPAWN_FILES keys the scanned trees)",
            got: "no such file - stale enumeration entry; remove it",
          });
        }
      }
      if (sites === 0) {
        throw new Error("no Bun spawnSync call found in the scoped trees - anchor lost");
      }
      return mismatches;
    },
  },
  {
    // No bare mkdtemp in the test tree: TEMP_DIR_HELPER owns fixtures
    // and is the one file that may call it. Fixed-name writes under
    // os.tmpdir() are the launcher's leftover check's to catch.
    name: "temp-dirs-through-helper",
    run: () => tempDirTreeMismatches(walkFiles("tests"), read),
  },
  {
    // Tests never sit beside an action's sources: the launcher runs
    // tests/ alone, and the build tree ships actions without tests.
    name: "no-tests-under-actions",
    run: () => actionTestFileMismatches(walkFiles("actions")),
  },
  {
    // No async process stream write in the executable trees: on pipe-backed
    // stdio (the Actions runner shape) bun queues these writes, and a
    // process.exit later in the run drops everything past the pipe buffer
    // (measured at 64 KiB on bun 1.3.14, 128 KiB on 1.4.0); 13 sites were
    // converted one truncation at a time before this rule pinned the class.
    // Scope: scripts/**, .github/scripts/**, actions/** minus *.test.ts; tests
    // are excluded because bun-test owns a test's process lifecycle, so the
    // shape cannot occur there (tests/shared/stream_write_discipline.test.ts guards that side).
    name: "stream-write-sync",
    run: () => {
      const files = ["scripts", ".github/scripts", "actions"].flatMap((root) => {
        const found = walkFiles(root)
          .filter(
            (f) =>
              !f.symlink && /\.[mc]?[jt]s$/.test(f.path) && !/\.test\.[mc]?[jt]s$/.test(f.path),
          )
          .map((f) => f.path);
        if (found.length === 0) throw new Error(`${root}: no scripts to scan - anchor lost`);
        return found;
      });
      const present = new Set(files);
      const mismatches = files.flatMap((rel) =>
        asyncStreamWriteMismatches(rel, read(rel), NATURAL_EXIT_WRITE_FILES.has(rel)),
      );
      // Existence control on the allowlist keys themselves: an entry
      // naming a file the walk never sees would excuse nothing, silently.
      for (const rel of [...NATURAL_EXIT_WRITE_FILES].sort()) {
        if (!present.has(rel)) {
          mismatches.push({
            file: rel,
            expected: "a scanned file (NATURAL_EXIT_WRITE_FILES keys the scanned trees)",
            got: "no such file - stale allowlist entry; remove it",
          });
        }
      }
      return mismatches;
    },
  },
];
