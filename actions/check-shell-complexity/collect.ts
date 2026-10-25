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
  type Document,
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

/** One shell body; `line` is the 1-based line its first line sits on. */
export interface CollectedBody {
  path: string;
  line: number;
  kind: SourceKind;
  dialect: Dialect;
  code: string;
}

/** A file of a judged kind the reader could not read as yaml: skipped and named, never a failure. */
export interface CollectProblem {
  path: string;
  line: number;
  message: string;
}

export interface Collected {
  bodies: CollectedBody[];
  problems: CollectProblem[];
}

interface HeredocRange {
  start: number;
  end: number;
}

/** A workflow file: any checkout's `.github/workflows/`. */
const WORKFLOW_PATH = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

/** A composite action's metadata file. */
const ACTION_NAME = /^action\.ya?ml$/;

/** A moon task file: the repository's `moon.yml`, or any yaml under `.moon/`. */
const MOON_PATH = /(^|\/)(moon\.yml|\.moon\/.*\.yml)$/;

/** A Dockerfile or Containerfile: bare, suffixed (`Dockerfile.dev`), or as an extension (`app.Dockerfile`). */
const CONTAINERFILE_NAME = /^(Dockerfile|Containerfile)(\..+)?$|\.(Dockerfile|Containerfile)$/;

/** Script dialect by extension. A Map, not a record (SHELL_DIALECT too): a key the repository controls must find nothing when it names an inherited property such as `constructor`. */
const SCRIPT_DIALECT: ReadonlyMap<string, Dialect> = new Map([
  [".sh", "bash"],
  [".bash", "bash"],
  [".zsh", "bash"],
  [".ps1", "powershell"],
  [".psm1", "powershell"],
  [".bat", "cmd"],
  [".cmd", "cmd"],
]);

/** The `shell:` of a run step by its first word (`bash -e {0}` is bash), or the runner's default when unset: pwsh on a Windows runner, bash elsewhere; any other shell (python, a custom template) is not shell. */
const SHELL_DIALECT: ReadonlyMap<string, Dialect> = new Map([
  ["bash", "bash"],
  ["sh", "bash"],
  ["zsh", "bash"],
  ["pwsh", "powershell"],
  ["powershell", "powershell"],
  ["cmd", "cmd"],
]);

/** `#!`, the interpreter, and an optional first argument (`env bash`). */
const SHEBANG = /^#!\s*(\S+)(?:[ \t]+(\S+))?/;

/** Each dialect's line continuation: syntactically nothing, one source line. */
const CONTINUATION: Readonly<Record<Dialect, string>> = {
  bash: " \\\n",
  powershell: " `\n",
  cmd: " ^\n",
};

/** A heredoc marker alone on the RUN's first line; the delimiter is any run of non-blank characters, bare or quoted (`EOF`, `EOF-SCRIPT`, `'EOF'`). */
const HEREDOC_ALONE = /^\s*<<-?\S+\s*$/;

export function sourceKindOf(relPath: string): SourceKind | null {
  const name = basename(relPath);
  if (WORKFLOW_PATH.test(relPath)) return "workflow";

  if (ACTION_NAME.test(name)) return "action";

  if (MOON_PATH.test(relPath)) return "moon";

  if (CONTAINERFILE_NAME.test(name)) return "containerfile";

  if (SCRIPT_DIALECT.has(extensionOf(name))) return "script";

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
  return SHELL_DIALECT.get(shellName(word)) ?? null;
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
      const dialect = SCRIPT_DIALECT.get(extensionOf(basename(relPath)));
      if (dialect === undefined) return { bodies: [], problems: [] };

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

/** A hook or tool script with no extension (`.githooks/pre-commit`, `.profile`); its shebang names the shell. */
export function isExtensionless(relPath: string): boolean {
  return basename(relPath).lastIndexOf(".") <= 0;
}

/** The dialect a first-line shebang names, `#!/usr/bin/env bash` included; null for no shebang or another program. */
export function shebangDialect(text: string): Dialect | null {
  const match = SHEBANG.exec(text.split("\n", 1)[0] ?? "");
  if (match === null) return null;

  const program = basename(match[1]) === "env" ? (match[2] ?? "") : match[1];
  return SHELL_DIALECT.get(shellName(program)) ?? null;
}

/** A block scalar's content starts on the line after its `|` or `>` header; any other scalar starts where it is written. */
function scalarLine(scalar: Scalar, lines: LineCounter): number {
  const { line } = lines.linePos(scalar.range?.[0] ?? 0);
  return scalar.type === "BLOCK_LITERAL" || scalar.type === "BLOCK_FOLDED" ? line + 1 : line;
}

/** A `run: *script` or `shell: *ps` alias is the anchored node. */
function resolved(doc: Document, node: unknown): unknown {
  return isAlias(node) ? node.resolve(doc) : node;
}

function scalarAt(doc: Document, node: unknown): Scalar | null {
  const target = resolved(doc, node);
  return isScalar(target) ? target : null;
}

function valueAt(doc: Document, node: unknown): unknown {
  return scalarAt(doc, node)?.value ?? resolved(doc, node);
}

/** A shell body where the yaml keeps it: the scalar, and the dialect its `shell` names (null for one that is not shell). */
interface YamlScript {
  scalar: Scalar;
  dialect: Dialect | null;
}

/** The `run` steps of one `steps` sequence, each under its own `shell`, else the `inherited` default, else `unset`. */
function stepScripts(
  doc: Document,
  steps: unknown,
  inherited: unknown,
  unset: Dialect,
): YamlScript[] {
  if (!isSeq(steps)) return [];

  const scripts: YamlScript[] = [];
  for (const step of steps.items) {
    if (!isMap(step)) continue;

    const run = scalarAt(doc, step.get("run", true));
    if (run === null) continue;

    const shell = step.has("shell") ? valueAt(doc, step.get("shell", true)) : inherited;
    scripts.push({ scalar: run, dialect: dialectOfShell(shell, unset) });
  }

  return scripts;
}

/** Every job's steps, under the job's `defaults.run.shell`, else the workflow's, else its runner's default. */
function workflowScripts(doc: Document): YamlScript[] {
  const jobs = doc.get("jobs");
  const workflowShell = valueAt(doc, doc.getIn(["defaults", "run", "shell"], true));
  const scripts: YamlScript[] = [];
  for (const { value: job } of isMap(jobs) ? jobs.items : []) {
    if (!isMap(job)) continue;

    const jobShell = job.hasIn(["defaults", "run", "shell"])
      ? valueAt(doc, job.getIn(["defaults", "run", "shell"], true))
      : workflowShell;
    const unset = runnerDefault(valueAt(doc, job.get("runs-on", true)));
    scripts.push(...stepScripts(doc, job.get("steps"), jobShell, unset));
  }

  return scripts;
}

/** Every task's `script`, bash as moon runs it. */
function moonScripts(doc: Document): YamlScript[] {
  const tasks = doc.get("tasks");
  const scripts: YamlScript[] = [];
  for (const { value: task } of isMap(tasks) ? (tasks as YAMLMap).items : []) {
    if (!isMap(task)) continue;

    const script = scalarAt(doc, task.get("script", true));
    if (script !== null) scripts.push({ scalar: script, dialect: "bash" });
  }

  return scripts;
}

function yamlScripts(doc: Document, kind: "workflow" | "action" | "moon"): YamlScript[] {
  switch (kind) {
    case "workflow":
      return workflowScripts(doc);
    case "action":
      return stepScripts(doc, doc.getIn(["runs", "steps"]), undefined, "bash");
    case "moon":
      return moonScripts(doc);
  }
}

/** The body as a shell parser should read it. GitHub substitutes `${{ }}` before any shell reads the body, so a
 *  parser sees a plain word in its place. The lines a multi-line expression spanned stay as line continuations, so a
 *  construct after it keeps its line. A `}}` inside the expression's own quoted string (`format('{{...}}', x)`) does
 *  not end it. */
function yamlBody(scalar: Scalar, dialect: Dialect): string {
  return String(scalar.value).replace(
    /\$\{\{(?:'[^']*'|[^'])*?\}\}/g,
    (expression) => `expression${CONTINUATION[dialect].repeat(expression.split("\n").length - 1)}`,
  );
}

function collectYaml(
  relPath: string,
  text: string,
  kind: "workflow" | "action" | "moon",
): Collected {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
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
  for (const { scalar, dialect } of yamlScripts(doc, kind)) {
    if (dialect === null) continue;

    bodies.push({
      path: relPath,
      line: scalarLine(scalar, lines),
      kind,
      dialect,
      code: yamlBody(scalar, dialect),
    });
  }

  return { bodies, problems: [] };
}

/** The dialect a `FROM` starts with: a prior stage's when it names one (stage names fold case, as Docker keeps them),
 *  bash for a fresh base. */
function fromDialect(from: From, stages: ReadonlyMap<string, Dialect | null>): Dialect | null {
  const base = (from.getImage() ?? "").toLowerCase();
  if (!stages.has(base)) return "bash";

  return stages.get(base) ?? null;
}

/** The dialect a `SHELL` instruction sets: pwsh or cmd, or null for a program that is no shell. */
function shellDialect(instruction: JSONInstruction): Dialect | null {
  const program = instruction.getJSONStrings()[0]?.getJSONValue();
  if (program === undefined) return null;

  return SHELL_DIALECT.get(shellName(program)) ?? null;
}

/** A heredoc script names its own interpreter, whatever the stage's SHELL: a shell shebang is judged as that shell, any
 *  other is not shell. Only `<<-` strips leading tabs, so only there may the shebang sit behind them. */
function heredocBody(
  relPath: string,
  sourceLines: readonly string[],
  heredoc: HeredocRange,
  marker: string,
  dialect: Dialect | null,
): CollectedBody | null {
  const { start, end } = heredoc;
  const body = sourceLines.slice(start, end + 1).join("\n");
  const script = /^\s*<<-/.test(marker) ? body.replace(/^\t+/, "") : body;
  const bodyDialect = script.startsWith("#!") ? shebangDialect(script) : dialect;
  if (bodyDialect === null) return null;

  return {
    path: relPath,
    line: start + 1,
    kind: "containerfile",
    dialect: bodyDialect,
    code: body,
  };
}

/** A RUN's shell body under the stage's `dialect`, or null: the exec form (a JSON array of strings) is no shell, and so
 *  is a stage whose SHELL names none. `RUN [ -f x ]` is not JSON and is shell. A RUN whose first line is a heredoc
 *  marker alone (`RUN <<EOF`) is the heredoc's content; a heredoc beside a command (`RUN cat <<EOF`) is that command's
 *  data. */
function runBody(
  relPath: string,
  sourceLines: readonly string[],
  instruction: Instruction,
  dialect: Dialect | null,
): CollectedBody | null {
  const code = instruction.getArgumentsContent();
  const first = instruction.getArguments()[0];
  if (code === null || first === undefined || isExecForm(code)) return null;

  const marker = code.split("\n")[0];
  const heredoc = HEREDOC_ALONE.test(marker) ? heredocRange(instruction) : null;
  if (heredoc !== null) return heredocBody(relPath, sourceLines, heredoc, marker, dialect);

  if (dialect === null) return null;

  return {
    path: relPath,
    line: first.getRange().start.line + 1,
    kind: "containerfile",
    dialect,
    code,
  };
}

/** Every RUN in shell form, including the `--mount` flags dockerfile-ast strips, under its stage's `SHELL`: bash for a
 *  fresh base, a prior stage's when `FROM` names one, and whatever a `SHELL` instruction sets after that. */
function collectContainerfile(relPath: string, text: string): CollectedBody[] {
  const sourceLines = text.split("\n");
  const bodies: CollectedBody[] = [];
  const stages = new Map<string, Dialect | null>();
  let stage: string | null = null;
  let dialect: Dialect | null = "bash";
  const rememberStage = (): void => {
    if (stage !== null) stages.set(stage, dialect);
  };
  for (const instruction of DockerfileParser.parse(text).getInstructions()) {
    const keyword = instruction.getKeyword().toUpperCase();
    if (keyword === "FROM") {
      const from = instruction as From;
      dialect = fromDialect(from, stages);
      stage = from.getBuildStage()?.toLowerCase() ?? null;
      rememberStage();
      continue;
    }

    if (keyword === "SHELL") {
      dialect = shellDialect(instruction as JSONInstruction);
      rememberStage();
      continue;
    }

    if (keyword !== "RUN") continue;

    const body = runBody(relPath, sourceLines, instruction, dialect);
    if (body !== null) bodies.push(body);
  }

  return bodies;
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
