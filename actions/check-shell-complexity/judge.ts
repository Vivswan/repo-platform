// The rule is the only part that is ours: one level of a construct passes, a construct inside another is refused, a
// function at any depth. Every parse is a library's or the language's own parser, which is why PowerShell goes out to
// pwsh and cmd, which no parser serves, is judged by tokens: nesting there is a keyword count, not structure, and a
// keyword inside a quoted argument counts like the real thing; the allow-list is the remedy.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BinaryCmd, CallExpr, Node, ParseError, WhileClause } from "mvdan-sh";
import mvdan from "mvdan-sh";
import { capture, failureDetail, succeeded } from "../shared/action_runtime.ts";

export type Dialect = "bash" | "powershell" | "cmd";

/** `line` is 1-based within the judged body. */
export interface Refusal {
  line: number;
  construct: string;
}

export interface Body {
  id: string;
  dialect: Dialect;
  code: string;
}

export const DIALECT_LABEL: Readonly<Record<Dialect, string>> = {
  bash: "bash/sh/zsh",
  powershell: "PowerShell",
  cmd: "cmd",
};

const { syntax } = mvdan;
// sh and zsh bodies parse as bash too: mvdan's bash is a superset of POSIX sh, and its zsh variant is experimental.
const bashParser = syntax.NewParser(syntax.Variant(syntax.LangBash));

/** mvdan-sh exposes no operator constants, so the `||` operator's value is read off a parse of `a || b` once. */
const OR_OPERATOR = (() => {
  let op = -1;
  syntax.Walk(bashParser.Parse("a || b", "or.sh"), (node) => {
    if (node !== null && syntax.NodeType(node) === "BinaryCmd") op = (node as BinaryCmd).Op;
    return node !== null;
  });
  return op;
})();

/** A command substitution is refused only where its result is tested: inside `[[ ]]`, or as an argument of `test` or `[`,
 *  reached directly or through the executing wrappers `builtin`, `command`, and `command -p`; `command -v` and `-V`
 *  only look a name up. */
function testsItsArguments(node: Node): boolean {
  const type = syntax.NodeType(node);
  if (type === "TestClause") return true;
  if (type !== "CallExpr") return false;
  const words = (node as CallExpr).Args.map((word) => word.Lit());
  let at = 0;
  while (words[at] === "command" || words[at] === "builtin") {
    at += 1;
    while (words[at]?.startsWith("-")) {
      if (/[vV]/.test(words[at])) return false;
      at += 1;
    }
  }
  // `/usr/bin/test` is test; `[` never carries a path.
  const command = words[at]?.slice(words[at].lastIndexOf("/") + 1);
  return command === "test" || command === "[";
}

function isParseError(error: unknown): error is ParseError {
  return (
    typeof error === "object" && error !== null && typeof (error as ParseError).Error === "function"
  );
}

/** The construct a node opens, or null: an `elif`/`else` branch is its `if`'s, and a `||` directly under a `||` is the
 *  same chain. A command substitution is a construct only where its result is tested. */
function constructOf(node: Node, parent: Node | undefined, ancestors: Node[]): string | null {
  switch (syntax.NodeType(node)) {
    case "IfClause":
      return parent !== undefined && syntax.NodeType(parent) === "IfClause" ? null : "if";
    case "CaseClause":
      return "case";
    case "ForClause":
      return "for";
    case "WhileClause":
      return (node as WhileClause).Until ? "until" : "while";
    case "BinaryCmd": {
      if ((node as BinaryCmd).Op !== OR_OPERATOR) return null;
      // `a || b || c` nests right through a Stmt: the inner chain is the outer one.
      const enclosing = ancestors.findLast((ancestor) => syntax.NodeType(ancestor) !== "Stmt");
      const chained =
        enclosing !== undefined &&
        syntax.NodeType(enclosing) === "BinaryCmd" &&
        (enclosing as BinaryCmd).Op === OR_OPERATOR;
      return chained ? null : "||";
    }
    case "CmdSubst": {
      // Only what sits between this substitution and the one enclosing it can test its result.
      const enclosing = ancestors.findLastIndex(
        (ancestor) => syntax.NodeType(ancestor) === "CmdSubst",
      );
      return ancestors.slice(enclosing + 1).some(testsItsArguments) ? "$(...) tested" : null;
    }
    default:
      return null;
  }
}

/** One level of a construct is allowed; a construct inside another is refused, and so is a function at any depth. */
export function judgeBash(code: string): Refusal[] {
  let file: Node;
  try {
    file = bashParser.Parse(code, "body.sh");
  } catch (error) {
    if (!isParseError(error)) throw error;
    return [{ line: error.Pos.Line(), construct: `does not parse as bash: ${error.Text}` }];
  }
  const refusals: Refusal[] = [];
  const ancestors: Node[] = [];
  const opened: (string | null)[] = [];
  syntax.Walk(file, (node) => {
    if (node === null) {
      ancestors.pop();
      opened.pop();
      return false;
    }
    const construct = constructOf(node, ancestors[ancestors.length - 1], ancestors);
    if (syntax.NodeType(node) === "FuncDecl") {
      refusals.push({ line: node.Pos().Line(), construct: "function" });
    } else if (construct !== null) {
      const outer = opened.findLast((label) => label !== null);
      if (outer !== undefined) {
        const line = construct === "||" ? (node as BinaryCmd).OpPos.Line() : node.Pos().Line();
        refusals.push({ line, construct: `${construct} inside ${outer}` });
      }
    }
    ancestors.push(node);
    opened.push(construct);
    return true;
  });
  return dedupe(refusals);
}

/** `a || b || c` is two BinaryCmd nodes on one line and one finding. */
function dedupe(refusals: Refusal[]): Refusal[] {
  const seen = new Set<string>();
  return refusals.filter((refusal) => {
    const key = `${refusal.line}:${refusal.construct}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const CMD_COMMENT = /^@?\s*(rem\b|::)/i;
/** A keyword stands alone: `for` is a construct, `format` and `--for` are not. */
const CMD_CONSTRUCTS = ["if", "for"].map(
  (keyword) => [keyword, new RegExp(`(?<![\\w-])${keyword}(?![\\w-])`, "gi")] as const,
);
const CMD_GOTO = /(?<![\w-])goto(?![\w-])/i;
const CMD_CALL_LABEL = /(?<![\w-])call\s+:/i;
const CMD_LABEL = /^:[^:]/;

/** Tokens, since no cmd parser exists on npm: comment lines (`rem`, `::`) are dropped, then one construct keyword
 *  (`if`, `for`, a `||`) passes and a second is refused, nesting counted by keyword count rather than structure. A
 *  `goto`, a `:label` line, or a `call :label` is refused at any count: a jump is a script. */
export function judgeCmd(code: string): Refusal[] {
  const refusals: Refusal[] = [];
  const constructs: Refusal[] = [];
  code.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || CMD_COMMENT.test(line)) return;
    const at = index + 1;
    if (CMD_LABEL.test(line)) refusals.push({ line: at, construct: "label" });
    if (CMD_GOTO.test(line)) refusals.push({ line: at, construct: "goto" });
    if (CMD_CALL_LABEL.test(line)) refusals.push({ line: at, construct: "call :label" });
    for (const [keyword, pattern] of CMD_CONSTRUCTS) {
      // Every occurrence counts: `if exist x if exist y` is two constructs on one line.
      for (const _ of line.matchAll(pattern)) constructs.push({ line: at, construct: keyword });
    }
    for (const _ of line.matchAll(/\|\|/g)) constructs.push({ line: at, construct: "||" });
  });
  if (constructs.length >= 2) {
    const names = constructs.map((construct) => construct.construct).join(", ");
    refusals.push({
      line: constructs[1].line,
      construct: `${constructs.length} constructs (${names})`,
    });
  }
  return refusals.sort((a, b) => a.line - b.line);
}

export const POWERSHELL_SCRIPT = join(import.meta.dir, "find-constructs.ps1");
const PWSH_TIMEOUT_MS = 120_000;

interface PowerShellResult {
  id: string;
  findings: PowerShellConstruct[] | null;
}

/** What find-constructs.ps1 emits per construct: its line, its label, and the nearest construct enclosing it. */
interface PowerShellConstruct {
  line: number;
  construct: string;
  outer: string | null;
}

/** The depth rule, as judgeBash applies it: a construct inside another is refused, a function at any depth, and a
 *  parse error as reported. */
function refusalsOf(constructs: PowerShellConstruct[]): Refusal[] {
  const refusals: Refusal[] = [];
  for (const { line, construct, outer } of constructs) {
    if (construct === "function" || construct.startsWith("does not parse")) {
      refusals.push({ line, construct });
    } else if (outer !== null) {
      refusals.push({ line, construct: `${construct} inside ${outer}` });
    }
  }
  return refusals;
}

/** One pwsh per batch: it reads the bodies from a file this call owns and removes, so a refused body never rides argv. */
export function judgePowerShell(bodies: Body[]): Map<string, Refusal[]> {
  const judged = new Map<string, Refusal[]>();
  if (bodies.length === 0) return judged;
  const scratch = mkdtempSync(join(tmpdir(), "check-shell-complexity-"));
  try {
    const input = join(scratch, "bodies.json");
    writeFileSync(input, JSON.stringify(bodies.map(({ id, code }) => ({ id, code }))));
    const result = run([
      "pwsh",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      POWERSHELL_SCRIPT,
      input,
    ]);
    for (const { id, findings } of JSON.parse(result) as PowerShellResult[]) {
      judged.set(id, refusalsOf(findings ?? []));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const { id } of bodies) {
    if (!judged.has(id)) throw new Error(`pwsh returned no verdict for ${id}`);
  }
  return judged;
}

function run(command: string[]): string {
  let result: ReturnType<typeof capture>;
  try {
    result = capture(command, { timeoutMs: PWSH_TIMEOUT_MS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `pwsh is not on PATH, so the PowerShell bodies cannot be judged (install PowerShell on the runner): ${detail}`,
    );
  }
  if (!succeeded(result.exit)) throw new Error(`pwsh failed: ${failureDetail(result)}`);
  return result.stdout;
}
