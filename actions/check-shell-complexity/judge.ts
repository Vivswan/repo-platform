// The rule is the only part that is ours: one level of a construct passes, a construct inside another is refused, a
// function at any depth. Every parse is a library's or the language's own parser, which is why PowerShell goes out to
// pwsh and cmd, which no parser serves, is judged by tokens: nesting there is a keyword count, not structure, and a
// keyword inside a quoted argument counts like the real thing; the allow-list is the remedy.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BinCmdOperator,
  type File,
  LangVariant,
  type Node,
  ParseError,
  parse,
  ShSyntaxError,
  type Word,
  walk,
} from "sh-syntax/sync";
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

/** A construct a node opens, at the line a finding names: its keyword's, or a `||` chain's operator's. */
interface Construct {
  label: string;
  line: number;
}

/** Each dialect as the report names it. */
export const DIALECT_LABEL: Readonly<Record<Dialect, string>> = {
  bash: "bash/sh/zsh",
  powershell: "PowerShell",
  cmd: "cmd",
};

/** sh and zsh bodies parse as bash too: mvdan/sh's bash is a superset of POSIX sh, and its zsh variant is experimental. */
const AS_BASH = { variant: LangVariant.LangBash } as const;

/** sh-syntax gives a language error's place only in its message: `2:6: parameter expansion flags are a zsh feature`. */
const LANGUAGE_ERROR = /^(\d+):\d+: (.*)$/s;

/** The word's text when it is plain literals only, else "": a quoted or expanded word names no command. */
function literalOf(word: Word): string {
  const texts: string[] = [];
  for (const part of word.parts) {
    if (part.type !== "Lit") return "";

    texts.push(part.value);
  }

  return texts.join("");
}

/** A command substitution is refused only where its result is tested: inside `[[ ]]`, or as an argument of `test` or `[`,
 *  reached directly or through the executing wrappers `builtin`, `command`, and `command -p`; `command -v` and `-V`
 *  only look a name up. */
function testsItsArguments(node: Node): boolean {
  if (node.type === "TestClause") return true;

  if (node.type !== "CallExpr") return false;

  const words = node.args.map(literalOf);
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

/** The construct a node opens, or null: an `elif`/`else` branch is its `if`'s, and a `||` directly under a `||` is the
 *  same chain. A command substitution is a construct only where its result is tested. */
function constructOf(node: Node, ancestors: Node[]): Construct | null {
  switch (node.type) {
    case "IfClause": {
      const branch = ancestors.at(-1)?.type === "IfClause";
      return branch ? null : { label: "if", line: node.position.line };
    }
    case "CaseClause":
      return { label: "case", line: node.case.line };
    case "ForClause":
      return { label: "for", line: node.forPos.line };
    case "WhileClause":
      return { label: node.until ? "until" : "while", line: node.whilePos.line };
    case "BinaryCmd": {
      if (node.op !== BinCmdOperator.OrStmt) return null;

      // `a || b || c` nests right through a Stmt: the inner chain is the outer one.
      const enclosing = ancestors.findLast((ancestor) => ancestor.type !== "Stmt");
      const chained = enclosing?.type === "BinaryCmd" && enclosing.op === BinCmdOperator.OrStmt;
      return chained ? null : { label: "||", line: node.opPos.line };
    }
    case "CmdSubst": {
      // Only what sits between this substitution and the one enclosing it can test its result, and only through the
      // test command's arguments: `X="$(x)" test -n ok` assigns the substitution, it does not test it.
      const enclosing = ancestors.findLastIndex((ancestor) => ancestor.type === "CmdSubst");
      const between = ancestors.slice(enclosing + 1);
      const tester = between.findLastIndex(testsItsArguments);
      if (tester === -1) return null;

      const assigned = between.slice(tester + 1).some((ancestor) => ancestor.type === "Assign");
      return assigned ? null : { label: "$(...) tested", line: node.left.line };
    }
    default:
      return null;
  }
}

/** The finding for a body the parser refused, at the parser's line. */
function unparsed(error: ShSyntaxError): Refusal {
  if (error instanceof ParseError) {
    return { line: error.pos?.line ?? 1, construct: `does not parse as bash: ${error.text}` };
  }

  const [, line = "1", text = error.message] = LANGUAGE_ERROR.exec(error.message) ?? [];
  return { line: Number(line), construct: `does not parse as bash: ${text}` };
}

/** One level of a construct is allowed; a construct inside another is refused, and so is a function at any depth. */
export function judgeBash(code: string): Refusal[] {
  let file: File;
  try {
    file = parse(code, AS_BASH);
  } catch (error) {
    if (!(error instanceof ShSyntaxError)) throw error;

    return [unparsed(error)];
  }

  const refusals: Refusal[] = [];
  const ancestors: Node[] = [];
  const opened: (string | null)[] = [];
  walk(file, {
    enter(node) {
      const construct = constructOf(node, ancestors);
      const outer = opened.findLast((label) => label !== null);
      if (node.type === "FuncDecl") {
        refusals.push({ line: node.position.line, construct: "function" });
      } else if (construct !== null && outer !== undefined) {
        refusals.push({ line: construct.line, construct: `${construct.label} inside ${outer}` });
      }
      ancestors.push(node);
      opened.push(construct?.label ?? null);
    },
    exit() {
      ancestors.pop();
      opened.pop();
    },
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

/** A comment line: `rem` or `::`, an `@` allowed before it. */
const CMD_COMMENT = /^@?\s*(rem\b|::)/i;

/** A keyword stands alone: `for` is a construct, `format` and `--for` are not; `||` counts wherever it appears. */
const CMD_CONSTRUCTS: readonly (readonly [string, RegExp])[] = [
  ["if", /(?<![\w-])if(?![\w-])/gi],
  ["for", /(?<![\w-])for(?![\w-])/gi],
  ["||", /\|\|/g],
];

/** A jump is a script, refused at any count. */
const CMD_JUMPS: readonly (readonly [RegExp, string])[] = [
  [/^:[^:]/, "label"],
  [/(?<![\w-])goto(?![\w-])/i, "goto"],
  [/(?<![\w-])call\s+:/i, "call :label"],
];

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
    for (const [pattern, construct] of CMD_JUMPS) {
      if (pattern.test(line)) refusals.push({ line: at, construct });
    }

    // Every occurrence counts: `if exist x if exist y` is two constructs on one line.
    for (const [construct, pattern] of CMD_CONSTRUCTS) {
      for (const _ of line.matchAll(pattern)) constructs.push({ line: at, construct });
    }
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
