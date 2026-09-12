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

function parsedExpression(text: string): Expression | null {
  const wrapped = `(${text});`;
  if (syntaxErrorCount(wrapped) > 0) return null; // recovered nodes are unauditable
  const statements = parseTs(wrapped).getStatements();
  const statement = statements.length === 1 ? statements[0] : undefined;
  if (statement === undefined || !Node.isExpressionStatement(statement)) return null;
  return unwrapExpression(statement.getExpression());
}

/** Read off the parsed literal, not split on commas: a comma or colon inside a nested value or a string could split or fake a property.
 *  Null means unauditable; the caller treats it as a hazard, so unreadable shapes fail closed. */
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

/** A stream value is judged as what it evaluates to, read off the parsed node, never its text (measured on 1.4.0):
 *    undefined, (undefined), void 0 in slots 1-2     -> default: spawnSync pipes it (an extra slot left undefined is a closed fd)
 *    "pipe", "p\x69pe"                               -> pipe
 *    null, "ignore", "inherit", an fd number         -> shaped
 *  An identifier or member path is trusted by its key (the recorded residual: a variable smuggling "pipe" escapes);
 *  a call, an optional chain, an operator expression, or a string bun-types does not list is refused. */
type StreamState = "default" | "pipe" | "shaped" | "unauditable";

function streamState(text: string | undefined): StreamState {
  if (text === undefined || text === "") return "default";
  const node = parsedExpression(text);
  if (node === null) return "unauditable";
  if (Node.isVoidExpression(node)) return "default";
  if (Node.isIdentifier(node)) return node.getText() === "undefined" ? "default" : "shaped";
  if (Node.isNullLiteral(node) || Node.isNumericLiteral(node)) return "shaped";
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    const value = node.getLiteralValue();
    if (value === "pipe") return "pipe";
    return value === "ignore" || value === "inherit" ? "shaped" : "unauditable";
  }
  return isMemberPath(node) ? "shaped" : "unauditable";
}

/** `a.b.c` and nothing else: a call or computed step anywhere in the chain is an expression, not a name.
 *  A `?.` step is refused with them: `options?.log` with options undefined is undefined, the piped default.
 *  `a[k]` is a computed step, not a path: an absent element is undefined too. */
function isMemberPath(node: Node): boolean {
  let current: Node = node;
  while (Node.isPropertyAccessExpression(current)) {
    if (current.hasQuestionDotToken()) return false;
    current = unwrapExpression(current.getExpression());
  }
  return Node.isIdentifier(current);
}

/** bun-types declares stdio as a [stdin, stdout, stderr] tuple, so only an array literal shows the slots; a call, a variable,
 *  or a scalar is refused rather than trusted whole. Parentheses and type dressing unwrap first: `(["pipe"])` is still the array it is. */
function stdioShape(
  text: string | undefined,
): { kind: "absent" } | { kind: "slots"; slots: string[] } | { kind: "unauditable"; why: string } {
  if (text === undefined) return { kind: "absent" };
  const literal = parsedExpression(text);
  if (literal === null) return { kind: "unauditable", why: "a stdio value the parser cannot read" };
  if (
    Node.isVoidExpression(literal) ||
    (Node.isIdentifier(literal) && literal.getText() === "undefined")
  ) {
    return { kind: "absent" };
  }
  if (!Node.isArrayLiteralExpression(literal)) {
    return { kind: "unauditable", why: "not an array literal, so its stream slots cannot be read" };
  }
  const elements = literal.getElements();
  if (elements.some(Node.isSpreadElement)) {
    return { kind: "unauditable", why: "a spread can shift or inject stream slots" };
  }
  return {
    kind: "slots",
    slots: elements.map((element) =>
      Node.isOmittedExpression(element) ? "" : element.getText().trim(),
    ),
  };
}

// A property access ending in the global's name (globalThis.Bun) counts too: over-matching someone else's `.Bun` is the loud direction.
// The recorded residual: an alias of the global itself (`const b = Bun; b.spawnSync(...)`), which nothing in house style writes.
function isGlobalReceiver(expression: Expression, name: string): boolean {
  const node = unwrapExpression(expression);
  if (Node.isIdentifier(node)) return node.getText() === name;
  return Node.isPropertyAccessExpression(node) && node.getName() === name;
}

/** Whole-word, not exact: a computed spelling in a destructure (`["spawnSync"]`) fails closed exactly like the plain key. */
function namesSpawnSync(nameText: string): boolean {
  return /(^|[^\w$])spawnSync([^\w$]|$)/.test(nameText) || nameText === "spawnSync";
}

/** `f(Bun.spawnSync)` passes the access as a value and `Bun.spawnSync.call(...)` calls a different member off it;
 *  neither is a direct call, so both read as null. */
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

export type SpawnSyncSite =
  | { line: number; kind: "call"; options: string | null }
  | { line: number; kind: "reference" };

/** The object-form overload carries its options beside `cmd`, so the whole argument list is returned;
 *  extra arguments ride along so topLevelProperties refuses the unauditable shape. */
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

export function spawnSyncSites(source: string, where: string): SpawnSyncSite[] {
  // A file the parser had to recover must not be judged: a truncated call's recovered options can read as a benign shape.
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
    // Any computed access on Bun is a reference: its property expression can spell spawnSync any way it likes.
    if (Node.isElementAccessExpression(node) && isGlobalReceiver(node.getExpression(), "Bun")) {
      sites.push({ line: node.getStartLineNumber(), kind: "reference" });
      continue;
    }
    // The initializer counts whenever its root identifier is Bun, so `= Bun.anything` fails closed too.
    //   const { spawnSync } = Bun  -> a binding pattern (parameter defaults included)
    //   ({ spawnSync } = Bun)      -> an assignment target (the BinaryExpression branch below)
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

/** Measured on the pinned bun: a piped sync spawn without an effective `timeout` returns at pipe EOF, not child exit,
 *  so a descendant holding the inherited pipe fds wedges the caller, and a bare call pipes both streams.
 *  Variable values are trusted by their key (rejecting identifiers would red proc.ts's own shorthand `timeout`),
 *  so a variable smuggling "pipe" or zero escapes: the recorded residual. */
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
    // `10_000` is a literal too; without stripping the separators a bounded call would misread as unprovable.
    const n = Number(timeout.replaceAll("_", ""));
    // An expression can evaluate to zero (`1 - 1`) and is unprovable, so only a plain identifier or member path counts as a non-numeric bound.
    bounded = Number.isNaN(n)
      ? /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(timeout)
      : Number.isFinite(n) && n > 0;
  }
  if (bounded) return null;
  const why = timeout === undefined ? "no timeout" : `timeout: ${timeout} is not a provable bound`;
  // bun-types: the stdio tuple overrides the stdout/stderr keys (measured: `stdio: ["inherit"]` beside `stdout: "ignore"` still pipes),
  // so the keys are read only when no tuple is given. Slot 1 is stdout, slot 2 stderr.
  const shape = stdioShape(props.get("stdio"));
  if (shape.kind === "unauditable") {
    return `a stdio value the scanner cannot audit (${shape.why}) with ${why}`;
  }
  const states: { stream: string; state: StreamState }[] = [];
  if (shape.kind === "slots") {
    for (let index = 1; index < Math.max(3, shape.slots.length); index++) {
      const state = streamState(shape.slots[index]);
      // spawnSync never drains a slot past 2, so a "pipe" there wedges once the pipe buffer fills (measured: a 1 MiB
      // writer into fd 3 hangs until the deadline), while an undefined or null extra slot is a closed fd, not a pipe.
      const closed = index > 2 && state === "default";
      states.push({
        stream: index === 1 ? "stdout" : index === 2 ? "stderr" : `stdio[${index}]`,
        state: closed ? "shaped" : state,
      });
    }
  } else {
    for (const stream of ["stdout", "stderr"] as const) {
      states.push({ stream, state: streamState(props.get(stream)) });
    }
  }
  if (states.some(({ state }) => state === "pipe")) return `explicitly piped stdio with ${why}`;
  const unauditable = states.filter(({ state }) => state === "unauditable");
  if (unauditable.length > 0) {
    return `${unauditable.map(({ stream }) => stream).join(" and ")} shaped by a value the scanner cannot audit (a call, an optional chain, or an expression) with ${why}`;
  }
  const defaulted = states.filter(({ state }) => state === "default");
  if (defaulted.length > 0) {
    return `${defaulted.map(({ stream }) => stream).join(" and ")} left to the piped default with ${why}`;
  }
  return null;
}

// Async Bun.spawn is enumerated rather than bounded: an async site draining both pipes has no pipe-EOF deadlock,
// so each caller records the rationale that bounds it.
// The set pins names, not a count: a bounded spawnSync rewritten as async would exit the sync gate silently,
// so the laundering must fail by introducing a name this pin does not carry.
//   an alias of Bun  -> escapes both scans
//   Bun["spawn"]     -> escapes this one
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
  "tests/actions/pages-site/mermaid_labels.test.ts":
    "headless Chrome for the file's one test: stderr is drained for the DevTools line and on; every wait on it sits under the test's timeout, and afterAll sends Browser.close and SIGKILLs a Chrome still alive 5 s later",
};

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
        "no async Bun.spawn outside ASYNC_SPAWN_FILES (an async site draining its pipes has no pipe-EOF " +
        "deadlock for a timeout to bound, so its bound is a recorded rationale rather than a checked option; " +
        "a sync site rewritten async exits the sync gate and must land here, by name)",
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

/** Measured on bun 1.4.0: the .mts, .cts, and .mjs spellings run too, beyond the four extensions the docs list.
 *  JSX variants are included as well; one would fail the parse loudly rather than escape. */
export const BUN_TEST_FILE = /[._](test|spec)\.[mc]?[jt]sx?$/;

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

/** The residual: an alias of the stream (`const out = process.stdout; out.write(x)`) escapes; nothing in house style writes that. */
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

/** A throw counts because the abort path drains no queued writes either; the roster names gha.ts's fail/requireEnv and proc.ts's must/mustCapture.
 *  Lexical order, not control-flow proof: a locally defined wrapper around process.exit stays a reviewable residual. */
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

/** Every exit-capable call in these files precedes the first async write, so the writes ride to a natural exit, which drains;
 *  asyncStreamWriteMismatches re-proves that per entry. */
export const NATURAL_EXIT_WRITE_FILES: ReadonlySet<string> = new Set([]);

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

export const processDisciplineRules: Rule[] = [
  {
    // spawnSyncHazard carries the measured bun semantics; the scope is this rule's.
    //   tests/**   -> in scope: a sync spawn blocks the runner, so bun-test's per-test timeout cannot interrupt a hung child,
    //                 and its 5s hook cap trips on cold starts; suites carry their own bounds
    //   proc.ts    -> not the bar for tests: they need stdio/env shapes it lacks, so tests/shared/bounded_spawn.ts is their remedy
    //   actions/** -> out of the sync walk: its sync spawns are the actions-bun-guard review surface
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
    // Tests never sit beside an action's sources: the launcher runs
    // tests/ alone, and the build tree ships actions without tests (branch_tree.ts).
    name: "no-tests-under-actions",
    run: () => actionTestFileMismatches(walkFiles("actions")),
  },
  {
    // On pipe-backed stdio (the Actions runner shape) bun queues async stream writes, and a later process.exit drops everything past the pipe buffer.
    // Tests are excluded: bun-test owns a test's process lifecycle, so the shape cannot occur there
    // (tests/shared/stream_write_discipline.test.ts guards that side).
    //   bun 1.3.14 -> 64 KiB pipe buffer
    //   bun 1.4.0  -> 128 KiB
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
