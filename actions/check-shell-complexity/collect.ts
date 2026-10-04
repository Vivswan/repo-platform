// Every inline shell body a checkout carries, with the file line it starts on, so a parser's line maps to the real one.
// The yaml and Dockerfile readers are libraries; this file only knows where each source kind keeps its shell.

import { basename } from "node:path";
import {
  DockerfileParser,
  type From,
  type Instruction,
  type JSONInstruction,
} from "dockerfile-ast";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Scalar,
  type YAMLMap,
} from "yaml";
import type { Dialect } from "./judge.ts";

export type SourceKind = "workflow" | "action" | "moon" | "containerfile" | "script";

export const SOURCE_LABEL: Readonly<Record<SourceKind, string>> = {
  workflow: "workflow run step",
  action: "composite action run step",
  moon: "moon task script",
  containerfile: "Containerfile RUN",
  script: "script file",
};

export interface CollectedBody {
  path: string;
  /** 1-based line the body's first line sits on. */
  line: number;
  kind: SourceKind;
  dialect: Dialect;
  code: string;
}

/** A file of a judged kind the reader could not read (yaml that does not parse): skipped and named, never a failure,
 *  since yamllint and actionlint own yaml validity. */
export interface CollectProblem {
  path: string;
  line: number;
  message: string;
}

export interface Collected {
  bodies: CollectedBody[];
  problems: CollectProblem[];
}

const WORKFLOW_PATH = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_NAME = /^action\.ya?ml$/;
const MOON_PATH = /(^|\/)(moon\.yml|\.moon\/.*\.yml)$/;
const CONTAINERFILE_NAME = /^(Dockerfile|Containerfile)(\..+)?$|\.(Dockerfile|Containerfile)$/;
const SCRIPT_DIALECT: Readonly<Record<string, Dialect>> = {
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".bat": "cmd",
  ".cmd": "cmd",
};
/** The `shell:` of a run step by its first word (`bash -e {0}` is bash), or the runner's default when unset: pwsh on a
 *  Windows runner, bash elsewhere. Any other shell (python, a custom template) is not shell. */
const SHELL_DIALECT: Readonly<Record<string, Dialect>> = {
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  pwsh: "powershell",
  powershell: "powershell",
  cmd: "cmd",
};

export function sourceKindOf(relPath: string): SourceKind | null {
  const name = basename(relPath);
  if (WORKFLOW_PATH.test(relPath)) return "workflow";
  if (ACTION_NAME.test(name)) return "action";
  if (MOON_PATH.test(relPath)) return "moon";
  if (CONTAINERFILE_NAME.test(name)) return "containerfile";
  if (extensionOf(name) in SCRIPT_DIALECT) return "script";
  return null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Unset, or an expression GitHub resolves at run time (`${{ matrix.shell }}`), is the runner default. */
export function dialectOfShell(shell: unknown, unset: Dialect): Dialect | null {
  if (shell === undefined || shell === null) return unset;
  const text = String(shell).trim();
  if (text.includes("${{")) return unset;
  const word = text.split(/\s+/)[0] ?? "";
  return SHELL_DIALECT[shellName(word)] ?? null;
}

/** A shell program by its bare name: `C:\...\pwsh.exe` and `powershell.exe` are pwsh and powershell. */
function shellName(program: string): string {
  return basename(program.replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/** A `runs-on` naming a Windows image or label; a matrix expression names none and reads as a Linux runner. */
export function runnerDefault(runsOn: unknown): Dialect {
  return /windows/i.test(JSON.stringify(runsOn ?? "")) ? "powershell" : "bash";
}

export function collectFile(relPath: string, text: string): Collected {
  const kind = sourceKindOf(relPath);
  switch (kind) {
    case "workflow":
    case "action":
    case "moon":
      return collectYaml(relPath, text, kind);
    case "containerfile":
      return { bodies: collectContainerfile(relPath, text), problems: [] };
    case "script": {
      const dialect = SCRIPT_DIALECT[extensionOf(basename(relPath))];
      return { bodies: [{ path: relPath, line: 1, kind, dialect, code: text }], problems: [] };
    }
    case null: {
      const dialect = isExtensionless(relPath) ? shebangDialect(text) : null;
      if (dialect === null) return { bodies: [], problems: [] };
      return {
        bodies: [{ path: relPath, line: 1, kind: "script", dialect, code: text }],
        problems: [],
      };
    }
  }
}

/** A hook or tool script with no extension (`.husky/pre-commit`, `.profile`); its shebang names the shell. */
export function isExtensionless(relPath: string): boolean {
  return basename(relPath).lastIndexOf(".") <= 0;
}

const SHEBANG = /^#!\s*(\S+)(?:[ \t]+(\S+))?/;

/** The dialect a first-line shebang names, `#!/usr/bin/env bash` included; null for no shebang or another program. */
export function shebangDialect(text: string): Dialect | null {
  const match = SHEBANG.exec(text.split("\n", 1)[0] ?? "");
  if (match === null) return null;
  const program = basename(match[1]) === "env" ? (match[2] ?? "") : match[1];
  return SHELL_DIALECT[shellName(program)] ?? null;
}

/** A sync writer's template carries `{{name}}` placeholders where its rendered copy carries yaml: the name alone stands
 *  in for an inline one, and a comment at the same indentation for a whole-line one (a block of steps, a line of a
 *  run body), so the template parses with its lines in place. `${{ }}` is GitHub's and stays. */
export function renderPlaceholders(text: string): string {
  return text
    .replace(/^([ \t]*)\{\{\s*(\w+)\s*\}\}[ \t]*$/gm, "$1# $2")
    .replace(/(?<!\$)\{\{\s*(\w+)\s*\}\}/g, "$1");
}

/** A block scalar's content starts on the line after its `|` or `>` header; any other scalar starts where it is written. */
function scalarLine(scalar: Scalar, lines: LineCounter): number {
  const { line } = lines.linePos(scalar.range?.[0] ?? 0);
  return scalar.type === "BLOCK_LITERAL" || scalar.type === "BLOCK_FOLDED" ? line + 1 : line;
}

function collectYaml(
  relPath: string,
  text: string,
  kind: "workflow" | "action" | "moon",
): Collected {
  const lines = new LineCounter();
  const doc = parseDocument(renderPlaceholders(text), { lineCounter: lines });
  if (doc.errors.length > 0) {
    const [error] = doc.errors;
    const line = error.linePos?.[0].line ?? 1;
    const message = error.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, "");
    return {
      bodies: [],
      problems: [{ path: relPath, line, message: `not readable as yaml: ${message}` }],
    };
  }
  const bodies: CollectedBody[] = [];
  const body = (scalar: Scalar, dialect: Dialect | null): void => {
    if (dialect === null) return;
    bodies.push({
      path: relPath,
      line: scalarLine(scalar, lines),
      kind,
      dialect,
      // GitHub substitutes `${{ }}` before any shell reads the body; a parser sees a plain word in its place. The lines
      // a multi-line expression spanned stay as line continuations, so a construct after it keeps its line. A `}}`
      // inside the expression's own quoted string (`format('{{...}}', x)`) does not end it.
      code: String(scalar.value).replace(
        /\$\{\{(?:'[^']*'|[^'])*?\}\}/g,
        (expression) =>
          `expression${CONTINUATION[dialect].repeat(expression.split("\n").length - 1)}`,
      ),
    });
  };
  // A `run: *script` or `shell: *ps` alias is the anchored node.
  const resolved = (node: unknown): unknown => (isAlias(node) ? node.resolve(doc) : node);
  const scalarAt = (node: unknown): Scalar | null => {
    const target = resolved(node);
    return isScalar(target) ? target : null;
  };
  const valueAt = (node: unknown): unknown => scalarAt(node)?.value ?? resolved(node);
  const runSteps = (steps: unknown, inherited: unknown, unset: Dialect): void => {
    if (!isSeq(steps)) return;
    for (const step of steps.items) {
      if (!isMap(step)) continue;
      const run = scalarAt(step.get("run", true));
      if (run === null) continue;
      const shell = step.has("shell") ? valueAt(step.get("shell", true)) : inherited;
      body(run, dialectOfShell(shell, unset));
    }
  };
  if (kind === "workflow") {
    const jobs = doc.get("jobs");
    const workflowShell = valueAt(doc.getIn(["defaults", "run", "shell"], true));
    for (const { value: job } of isMap(jobs) ? jobs.items : []) {
      if (!isMap(job)) continue;
      const jobShell = job.hasIn(["defaults", "run", "shell"])
        ? valueAt(job.getIn(["defaults", "run", "shell"], true))
        : workflowShell;
      runSteps(job.get("steps"), jobShell, runnerDefault(valueAt(job.get("runs-on", true))));
    }
  } else if (kind === "action") {
    runSteps(doc.getIn(["runs", "steps"]), undefined, "bash");
  } else {
    const tasks = doc.get("tasks");
    for (const { value: task } of isMap(tasks) ? (tasks as YAMLMap).items : []) {
      if (!isMap(task)) continue;
      const script = scalarAt(task.get("script", true));
      if (script !== null) body(script, "bash");
    }
  }
  return { bodies, problems: [] };
}

/** Each dialect's line continuation: syntactically nothing, one source line. */
const CONTINUATION: Readonly<Record<Dialect, string>> = {
  bash: " \\\n",
  powershell: " `\n",
  cmd: " ^\n",
};

/** A RUN in shell form, including the `--mount` flags dockerfile-ast strips, under its stage's `SHELL`: bash for a
 *  fresh base, a prior stage's when `FROM` names one (stage names fold case, as Docker keeps them), and whatever a
 *  `SHELL` instruction sets after that (pwsh or cmd, or no shell). The exec form, a JSON array of strings, is no shell;
 *  `RUN [ -f x ]` is not JSON and is shell. A RUN whose first line is a heredoc marker alone (`RUN <<EOF`) is the
 *  heredoc's content; a heredoc beside a command (`RUN cat <<EOF`) is that command's data. */
function collectContainerfile(relPath: string, text: string): CollectedBody[] {
  const sourceLines = text.split("\n");
  const bodies: CollectedBody[] = [];
  const stages = new Map<string, Dialect | null>();
  let stage: string | null = null;
  let dialect: Dialect | null = "bash";
  for (const instruction of DockerfileParser.parse(text).getInstructions()) {
    const keyword = instruction.getKeyword().toUpperCase();
    if (keyword === "FROM") {
      const from = instruction as From;
      const base = (from.getImage() ?? "").toLowerCase();
      dialect = stages.has(base) ? (stages.get(base) ?? null) : "bash";
      stage = from.getBuildStage()?.toLowerCase() ?? null;
      if (stage !== null) stages.set(stage, dialect);
      continue;
    }
    if (keyword === "SHELL") {
      const program = (instruction as JSONInstruction).getJSONStrings()[0]?.getJSONValue();
      dialect = program === undefined ? null : (SHELL_DIALECT[shellName(program)] ?? null);
      if (stage !== null) stages.set(stage, dialect);
      continue;
    }
    if (keyword !== "RUN" || dialect === null) continue;
    const code = instruction.getArgumentsContent();
    const first = instruction.getArguments()[0];
    if (code === null || first === undefined || isExecForm(code)) continue;
    const heredoc = HEREDOC_ALONE.test(code.split("\n")[0]) ? heredocRange(instruction) : null;
    if (heredoc !== null) {
      const { start, end } = heredoc;
      bodies.push({
        path: relPath,
        line: start + 1,
        kind: "containerfile",
        dialect,
        code: sourceLines.slice(start, end + 1).join("\n"),
      });
      continue;
    }
    bodies.push({
      path: relPath,
      line: first.getRange().start.line + 1,
      kind: "containerfile",
      dialect,
      code,
    });
  }
  return bodies;
}

interface HeredocRange {
  start: number;
  end: number;
}

/** Docker's own rule for the exec form: the arguments parse as a JSON array of strings; anything else is shell. */
function isExecForm(code: string): boolean {
  try {
    const parsed: unknown = JSON.parse(code);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string");
  } catch {
    return false;
  }
}

const HEREDOC_ALONE = /^\s*<<-?(["']?)\w+\1\s*$/;

/** dockerfile-ast keeps getHeredocs protected; the content range is the one thing read off it. */
function heredocRange(instruction: Instruction): HeredocRange | null {
  const heredocs = (
    instruction as unknown as {
      getHeredocs(): {
        getContentRange(): { start: { line: number }; end: { line: number } } | null;
      }[];
    }
  ).getHeredocs();
  const range = heredocs[0]?.getContentRange() ?? null;
  return range === null ? null : { start: range.start.line, end: range.end.line };
}
