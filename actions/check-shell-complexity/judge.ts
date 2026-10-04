// The rule is binary (a construct is refused or allowed) and it is the only part that is ours; every parse is a library's
// or the language's own parser, which is why PowerShell goes out to pwsh and cmd, which no parser serves, is judged by
// tokens: a keyword inside a quoted argument is refused like the real thing, and the allow-list is the remedy.

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
  syntax.Walk(file, (node) => {
    if (node === null) {
      ancestors.pop();
      return false;
    }
    const line = node.Pos().Line();
    switch (syntax.NodeType(node)) {
      case "IfClause":
        // An `elif` or `else` branch is an IfClause whose direct parent is the IfClause: the same construct, not a second one.
        if (syntax.NodeType(ancestors[ancestors.length - 1]) !== "IfClause") {
          refusals.push({ line, construct: "if" });
        }
        break;
      case "CaseClause":
        refusals.push({ line, construct: "case" });
        break;
      case "ForClause":
        refusals.push({ line, construct: "for" });
        break;
      case "WhileClause":
        refusals.push({ line, construct: (node as WhileClause).Until ? "until" : "while" });
        break;
      case "FuncDecl":
        refusals.push({ line, construct: "function" });
        break;
      case "BinaryCmd": {
        const binary = node as BinaryCmd;
        if (binary.Op === OR_OPERATOR)
          refusals.push({ line: binary.OpPos.Line(), construct: "||" });
        break;
      }
      case "CmdSubst":
        if (ancestors.some(testsItsArguments)) refusals.push({ line, construct: "$(...) tested" });
        break;
    }
    ancestors.push(node);
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
/** A keyword stands alone: `for` is refused, `format` and `--for` are not. */
const CMD_KEYWORDS = ["if", "for", "goto"].map(
  (keyword) => [keyword, new RegExp(`(?<![\\w-])${keyword}(?![\\w-])`, "i")] as const,
);
const CMD_CALL_LABEL = /(?<![\w-])call\s+:/i;
const CMD_CONTINUES = /(?<!\^)(\^\^)*\^\r?$/;

/** Tokens, since no cmd parser exists on npm: comment lines (`rem`, `::`) are dropped, a line ending in `^` continues
 *  on the next, then a body is refused for a second command line or for `if`, `for`, `goto`, `call :label`, or `||`
 *  anywhere on a line. */
export function judgeCmd(code: string): Refusal[] {
  const refusals: Refusal[] = [];
  let commands = 0;
  let continued = false;
  code.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    // An odd run of carets at the physical line end continues the line; `^^` is one literal caret.
    const continues = CMD_CONTINUES.test(raw);
    if (line === "" || CMD_COMMENT.test(line) || (continued && line === "^")) {
      continued = continued && continues;
      return;
    }
    if (!continued) commands += 1;
    continued = continues;
    const at = index + 1;
    if (commands === 2 && !refusals.some((r) => r.construct === "a second command line")) {
      refusals.push({ line: at, construct: "a second command line" });
    }
    for (const [keyword, pattern] of CMD_KEYWORDS) {
      if (pattern.test(line)) refusals.push({ line: at, construct: keyword });
    }
    if (CMD_CALL_LABEL.test(line)) refusals.push({ line: at, construct: "call :label" });
    if (line.includes("||")) refusals.push({ line: at, construct: "||" });
  });
  return refusals;
}

export const POWERSHELL_SCRIPT = join(import.meta.dir, "find-constructs.ps1");
const PWSH_TIMEOUT_MS = 120_000;

interface PowerShellResult {
  id: string;
  findings: Refusal[] | null;
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
      judged.set(id, findings ?? []);
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
