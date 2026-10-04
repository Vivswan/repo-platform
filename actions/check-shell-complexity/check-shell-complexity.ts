#!/usr/bin/env bun

// Shell may carry one level of a construct; a construct inside another, or a function at any depth, is a TypeScript
// script run by bun. Policy: docs/fleet-guidelines.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workflowCommand } from "../shared/action_runtime.ts";
import { loadAllowlist, staleEntries } from "../shared/allowlist.ts";
import { type Outcome as CheckOutcome, runCheck } from "../shared/check_main.ts";
import { isManaged } from "../shared/managed_header.ts";
import { PLATFORM_NAME } from "../shared/platform.ts";
import { repositoryFiles } from "../shared/repository_files.ts";
import {
  type CollectedBody,
  type CollectProblem,
  collectFile,
  isExtensionless,
  SOURCE_LABEL,
  type SourceKind,
  shebangDialect,
  sourceKindOf,
} from "./collect.ts";
import {
  type Body,
  DIALECT_LABEL,
  type Dialect,
  judgeBash,
  judgeCmd,
  judgePowerShell,
} from "./judge.ts";

export const ALLOWLIST_FILE = ".shell-complexity-allow.local";
export const REASON_RULE =
  "an allowlist entry needs a reason a reader accepts (the block runs before bun exists, or the file is upstream-shaped)";
export const REMEDY = `move this block to a TypeScript script run by bun, or list the file in ${ALLOWLIST_FILE} with a # reason`;

/** Directories a repository may track whose files the check still leaves alone: vendored installs and build output.
 *  A repository's own such directory (a sync writer's templates) is the caller's `skip` input. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "third_party", "dist", "build", ".venv"]);

export interface Finding {
  path: string;
  /** 1-based line in the file. */
  line: number;
  construct: string;
  source: SourceKind;
  dialect: Dialect;
  /** Set when `path` is a template and `line` is the written tree's. */
  written?: WrittenLine;
}

/** A path of a written tree reported against the template that produced it: the template's line when the two map,
 *  else the written line named as such (a template with no record keeps its path, the tree named beside the line). */
function fromWritten<T extends { path: string; line: number }>(
  item: T,
  written: WrittenTree,
): T & { written?: WrittenLine } {
  const template = written.templates[item.path];
  if (template === undefined) return { ...item, written: { tree: written.tree } };
  if (template.lineMapped) return { ...item, path: template.path };
  return { ...item, path: template.path, written: { tree: written.tree } };
}

/** `path:line`, or the written tree's line when `line` is not the template's. */
export function where(item: { path: string; line: number; written?: WrittenLine }): string {
  return item.written === undefined
    ? `${item.path}:${item.line}`
    : `${item.path} (line ${item.line} of the written ${item.written.tree} tree)`;
}

export interface Verdict {
  findings: Finding[];
  /** Allow-list defects: entries without a reason, and stale entries. */
  allowlistErrors: string[];
  /** Bodies judged, by source kind. */
  bodies: Record<SourceKind, number>;
  /** Files carrying the platform's managed header: a fleet repository cannot fix such a file. */
  managedSkipped: number;
  /** Files of a judged kind the reader could not read as yaml: warned and skipped, never a failure. */
  unreadable: (CollectProblem & { written?: WrittenLine })[];
}

function isJudged(relPath: string, skip: ReadonlySet<string>): boolean {
  return !relPath
    .split("/")
    .slice(0, -1)
    .some((dir) => SKIP_DIRS.has(dir) || skip.has(dir));
}

/** Every refusal of every body, at file lines. */
export function judgeBodies(bodies: CollectedBody[]): Finding[] {
  const findings: Finding[] = [];
  const at = (body: CollectedBody, refusals: { line: number; construct: string }[]): void => {
    for (const { line, construct } of refusals) {
      findings.push({
        path: body.path,
        line: body.line + line - 1,
        construct,
        source: body.kind,
        dialect: body.dialect,
      });
    }
  };
  const powershell: (Body & { body: CollectedBody })[] = [];
  bodies.forEach((body, index) => {
    if (body.dialect === "bash") at(body, judgeBash(body.code));
    else if (body.dialect === "cmd") at(body, judgeCmd(body.code));
    else powershell.push({ id: String(index), dialect: "powershell", code: body.code, body });
  });
  const judged = judgePowerShell(powershell);
  for (const { id, body } of powershell) at(body, judged.get(id) ?? []);
  return findings;
}

/** `judgeManaged`: the platform's own run over the fleet trees its writer lands, where the managed files are its own
 *  to fix; a fleet repository never judges them. */
/** `judgeManaged`: the platform's own run over the fleet trees its writer lands, where the managed files are its own
 *  to fix; a fleet repository never judges them. `written`: that tree's name and each written file's template, so a
 *  finding points at the template that produced it rather than at a same-named file of the checkout. */
export interface CheckOptions {
  judgeManaged: boolean;
  written?: WrittenTree;
  /** Directory names of the caller's own the check must not read, beside the generic skip set. */
  skip?: readonly string[];
}

export interface WrittenTree {
  tree: string;
  /** Written path to its template; `lineMapped` when the template's lines are the written file's (no block splice). */
  templates: Record<string, { path: string; lineMapped: boolean }>;
}

/** Set on a remapped item whose `line` is the written tree's, not the template's. */
export interface WrittenLine {
  tree: string;
}

export function check(root: string, options: CheckOptions = { judgeManaged: false }): Verdict {
  const allow = loadAllowlist(root, ALLOWLIST_FILE, REASON_RULE);
  const skip = new Set(options.skip ?? []);
  const bodies: CollectedBody[] = [];
  const unreadable: CollectProblem[] = [];
  const counts: Record<SourceKind, number> = {
    workflow: 0,
    action: 0,
    moon: 0,
    containerfile: 0,
    script: 0,
  };
  let managedSkipped = 0;
  // An extensionless file is shell only by its shebang, and only a tracked one is read: husky's generated hooks under
  // .husky/_/ are untracked.
  const tracked = new Set(repositoryFiles(root, { untracked: false }));
  for (const relPath of repositoryFiles(root, { untracked: true })) {
    if (!isJudged(relPath, skip)) continue;
    const named = sourceKindOf(relPath);
    if (named === null && !(tracked.has(relPath) && isExtensionless(relPath))) continue;
    const text = readFileSync(join(root, relPath), "utf-8");
    if (named === null && shebangDialect(text) === null) continue;
    if (!options.judgeManaged && isManaged(text)) {
      managedSkipped += 1;
      continue;
    }
    const collected = collectFile(relPath, text);
    counts[named ?? "script"] += collected.bodies.length;
    bodies.push(...collected.bodies);
    unreadable.push(...collected.problems);
  }
  const findings = judgeBodies(bodies).sort(
    (a, b) =>
      a.path.localeCompare(b.path) || a.line - b.line || a.construct.localeCompare(b.construct),
  );
  const found = new Set(findings.map((finding) => finding.path));
  const written = options.written;
  return {
    findings: findings
      .filter((finding) => !allow.allowed.has(finding.path))
      .map((finding) => (written === undefined ? finding : fromWritten(finding, written))),
    allowlistErrors: [
      ...allow.failures,
      ...staleEntries(allow, found, ALLOWLIST_FILE, "no refused construct"),
    ],
    bodies: counts,
    managedSkipped,
    unreadable:
      written === undefined
        ? unreadable
        : unreadable.map((problem) => fromWritten(problem, written)),
  };
}

export function describe(finding: Finding): string {
  return `${where(finding)}: ${finding.construct}; ${REMEDY}`;
}

export type Outcome = CheckOutcome<Verdict>;

export function outcomeOf(verdict: Verdict): Outcome {
  const silent = verdict.findings.length + verdict.allowlistErrors.length === 0;
  return { state: silent ? "clean" : "findings", verdict };
}

function census(verdict: Verdict): string {
  const judged = (Object.entries(verdict.bodies) as [SourceKind, number][])
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${SOURCE_LABEL[kind]}${count === 1 ? "" : "s"}`);
  const parts = [`Bodies judged: ${judged.length === 0 ? "none" : judged.join(", ")}.`];
  if (verdict.managedSkipped > 0) {
    parts.push(`${verdict.managedSkipped} managed file(s) skipped; ${PLATFORM_NAME} owns them.`);
  }
  if (verdict.unreadable.length > 0) {
    parts.push(
      `${verdict.unreadable.length} file(s) not readable as yaml and skipped: ${verdict.unreadable.map((problem) => `\`${where(problem)}\``).join(", ")}.`,
    );
  }
  return parts.join(" ");
}

/** A `||` construct is a table cell too. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

export function report(outcome: Outcome): string {
  const parts = ["## Shell complexity check", ""];
  if (outcome.state === "error") {
    parts.push(`The check did not run to completion: ${outcome.message}`);
    return `${parts.join("\n")}\n`;
  }
  const { findings, allowlistErrors } = outcome.verdict;
  if (outcome.state === "clean") {
    parts.push("Every shell body stays within one level of a construct.");
  } else {
    parts.push(`${findings.length} refused construct(s) (fails).`);
    if (findings.length > 0) {
      parts.push(
        "",
        "| Where | Construct | Source |",
        "| --- | --- | --- |",
        ...findings.map(
          (finding) =>
            `| \`${where(finding)}\` | \`${cell(finding.construct)}\` | ${SOURCE_LABEL[finding.source]}, ${DIALECT_LABEL[finding.dialect]} |`,
        ),
      );
    }
    if (allowlistErrors.length > 0) {
      parts.push("", `### ${ALLOWLIST_FILE}`, "", ...allowlistErrors.map((error) => `- ${error}`));
    }
    parts.push(
      "",
      `Move each block to a TypeScript script run by bun, or list the file in \`${ALLOWLIST_FILE}\` with a \`# reason\` (a block that must stay shell).`,
    );
  }
  parts.push("", census(outcome.verdict));
  return `${parts.join("\n")}\n`;
}

const JUDGE_MANAGED_FLAG = "--judge-managed";
const SOURCES_FLAG = "--sources";
const SKIP_FLAG = "--skip";

/** `--judge-managed` and `--sources <file>` are this check's; the root argument is the shared main's. */
function parseFlags(argv: string[]): { options: CheckOptions; rest: string[] } {
  const rest: string[] = [];
  const options: CheckOptions = { judgeManaged: false };
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] === JUDGE_MANAGED_FLAG) options.judgeManaged = true;
    else if (argv[at] === SOURCES_FLAG) {
      const file = argv[++at];
      if (file === undefined) throw new Error(`${SOURCES_FLAG} needs a file`);
      options.written = JSON.parse(readFileSync(file, "utf-8")) as WrittenTree;
    } else if (argv[at] === SKIP_FLAG) {
      // Comma-separated, the action input's shape; an empty value (the input unset) skips nothing.
      const names = argv[++at];
      if (names === undefined) throw new Error(`${SKIP_FLAG} needs directory names`);
      options.skip = names
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
    } else rest.push(argv[at]);
  }
  return { options, rest };
}

if (import.meta.main) {
  const { options, rest } = parseFlags(process.argv.slice(2));
  await runCheck<Verdict>(
    {
      name: "check-shell-complexity",
      check: (root) => check(root, options),
      outcomeOf,
      report,
      warnings: (verdict) =>
        verdict.unreadable.map((problem) =>
          workflowCommand(
            "warning",
            `${where(problem)}: ${problem.message}; skipped`,
            problem.path,
            problem.written === undefined ? problem.line : undefined,
          ),
        ),
      errors: (verdict) => [
        ...verdict.findings.map((finding) =>
          workflowCommand(
            "error",
            describe(finding),
            finding.path,
            finding.written === undefined ? finding.line : undefined,
          ),
        ),
        ...verdict.allowlistErrors.map((failure) => workflowCommand("error", failure)),
      ],
      passed: (verdict) => `Shell complexity check passed. ${census(verdict)}`,
      failed: (count) =>
        `${count} finding(s). Shell may nest no construct inside another; ${REMEDY}.`,
    },
    rest,
  );
}
