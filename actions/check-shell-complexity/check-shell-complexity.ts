#!/usr/bin/env bun

// Shell stays while it is a straight line of commands; the moment a body needs a branch, a loop, a function, `||`, or a
// tested `$(...)`, it is a TypeScript script run by bun. Policy: docs/fleet-guidelines.md.

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAllowlist } from "../shared/allowlist.ts";
import { isManaged } from "../shared/managed_header.ts";
import { PLATFORM_NAME } from "../shared/platform.ts";
import { repositoryFiles } from "../shared/repository_files.ts";
import {
  type CollectedBody,
  type CollectProblem,
  collectFile,
  SOURCE_LABEL,
  type SourceKind,
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

/** Directories a repository may track whose files the check still leaves alone: vendored installs and build output. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "third_party", "dist", "build", ".venv"]);

export interface Finding {
  path: string;
  /** 1-based line in the file. */
  line: number;
  construct: string;
  source: SourceKind;
  dialect: Dialect;
}

export interface Verdict {
  findings: Finding[];
  /** Allow-list defects: entries without a reason, and stale entries. */
  allowlistErrors: string[];
  /** Bodies judged, by source kind. */
  bodies: Record<SourceKind, number>;
  /** Files carrying the platform's managed header: a fleet repository cannot fix such a file. */
  managedSkipped: number;
  /** Files of a judged kind the reader could not read; yamllint owns yaml validity, so these warn and never fail. */
  unreadable: CollectProblem[];
}

function isJudged(relPath: string): boolean {
  return !relPath
    .split("/")
    .slice(0, -1)
    .some((dir) => SKIP_DIRS.has(dir));
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

export function check(root: string): Verdict {
  const allowFile = join(root, ALLOWLIST_FILE);
  const allow = existsSync(allowFile)
    ? parseAllowlist(readFileSync(allowFile, "utf-8"), ALLOWLIST_FILE, REASON_RULE)
    : { entries: [], failures: [] };
  const allowed = new Set(allow.entries.map((entry) => entry.path));
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
  for (const relPath of repositoryFiles(root, { untracked: true })) {
    const kind = sourceKindOf(relPath);
    if (kind === null || !isJudged(relPath)) continue;
    const text = readFileSync(join(root, relPath), "utf-8");
    if (isManaged(text)) {
      managedSkipped += 1;
      continue;
    }
    const collected = collectFile(relPath, text);
    counts[kind] += collected.bodies.length;
    bodies.push(...collected.bodies);
    unreadable.push(...collected.problems);
  }
  const findings = judgeBodies(bodies).sort(
    (a, b) =>
      a.path.localeCompare(b.path) || a.line - b.line || a.construct.localeCompare(b.construct),
  );
  const found = new Set(findings.map((finding) => finding.path));
  const allowlistErrors = [...allow.failures];
  for (const entry of allow.entries) {
    if (!found.has(entry.path)) {
      allowlistErrors.push(
        `${ALLOWLIST_FILE}:${entry.line}: '${entry.path}' is stale (no refused construct, or not a tracked file); remove the entry`,
      );
    }
  }
  return {
    findings: findings.filter((finding) => !allowed.has(finding.path)),
    allowlistErrors,
    bodies: counts,
    managedSkipped,
    unreadable,
  };
}

export function describe(finding: Finding): string {
  return `${finding.path}:${finding.line}: ${finding.construct}; ${REMEDY}`;
}

/** The three outcomes the action distinguishes (its `report` output). */
export type Outcome =
  | { state: "findings" | "clean"; verdict: Verdict }
  | { state: "error"; message: string };

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
      `${verdict.unreadable.length} file(s) not readable as yaml and skipped (yamllint owns yaml validity): ${verdict.unreadable.map((problem) => `\`${problem.path}:${problem.line}\``).join(", ")}.`,
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
    parts.push("Every shell body is a straight line of commands.");
  } else {
    parts.push(`${findings.length} refused construct(s) (fails).`);
    if (findings.length > 0) {
      parts.push(
        "",
        "| Where | Construct | Source |",
        "| --- | --- | --- |",
        ...findings.map(
          (finding) =>
            `| \`${finding.path}:${finding.line}\` | \`${cell(finding.construct)}\` | ${SOURCE_LABEL[finding.source]}, ${DIALECT_LABEL[finding.dialect]} |`,
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

export function parseArgs(argv: string[]): { root: string } {
  if (argv.length > 1) throw new Error(`unexpected argument(s): ${argv.slice(1).join(" ")}`);
  return { root: resolve(argv[0] ?? ".") };
}

/** Workflow-command payloads escape newlines, or a multi-line message would end the command at the first break. */
function annotation(finding: Finding): string {
  const message = describe(finding).replaceAll("%", "%25").replaceAll("\n", "%0A");
  return `::error file=${finding.path},line=${finding.line}::${message}`;
}

if (import.meta.main) {
  // Cleared first, so a crash below leaves no comment body behind.
  const reportPath = process.env.REPORT_PATH;
  if (reportPath) rmSync(reportPath, { force: true });
  const emit = (outcome: Outcome): void => {
    const body = report(outcome);
    if (reportPath && outcome.state === "findings") writeFileSync(reportPath, body);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `report=${outcome.state}\n`);
  };
  let verdict: Verdict;
  try {
    verdict = check(parseArgs(process.argv.slice(2)).root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::check-shell-complexity did not run to completion: ${message}`);
    emit({ state: "error", message });
    process.exit(1);
  }
  const failures = [
    ...verdict.findings.map(annotation),
    ...verdict.allowlistErrors.map((e) => `::error::${e}`),
  ];
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(
      `${failures.length} finding(s). Shell is a straight line of commands; ${REMEDY}.`,
    );
  } else {
    console.log(`Shell complexity check passed. ${census(verdict)}`);
  }
  // Last, so nothing after it can leave a recorded state the run's exit contradicts.
  emit(outcomeOf(verdict));
  process.exit(failures.length > 0 ? 1 : 0);
}
