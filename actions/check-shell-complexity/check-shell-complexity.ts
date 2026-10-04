#!/usr/bin/env bun

// Shell stays while it is a straight line of commands; the moment a body needs a branch, a loop, a function, `||`, or a
// tested `$(...)`, it is a TypeScript script run by bun. Policy: docs/fleet-guidelines.md.

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
  const allow = loadAllowlist(root, ALLOWLIST_FILE, REASON_RULE);
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
    if (!isJudged(relPath)) continue;
    const named = sourceKindOf(relPath);
    if (named === null && !(tracked.has(relPath) && isExtensionless(relPath))) continue;
    const text = readFileSync(join(root, relPath), "utf-8");
    if (named === null && shebangDialect(text) === null) continue;
    if (isManaged(text)) {
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
  return {
    findings: findings.filter((finding) => !allow.allowed.has(finding.path)),
    allowlistErrors: [
      ...allow.failures,
      ...staleEntries(allow, found, ALLOWLIST_FILE, "no refused construct"),
    ],
    bodies: counts,
    managedSkipped,
    unreadable,
  };
}

export function describe(finding: Finding): string {
  return `${finding.path}:${finding.line}: ${finding.construct}; ${REMEDY}`;
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

if (import.meta.main) {
  await runCheck<Verdict>({
    name: "check-shell-complexity",
    check,
    outcomeOf,
    report,
    warnings: (verdict) =>
      verdict.unreadable.map(({ path, line, message }) =>
        workflowCommand("warning", `${path}:${line}: ${message}; skipped`, path, line),
      ),
    errors: (verdict) => [
      ...verdict.findings.map((finding) =>
        workflowCommand("error", describe(finding), finding.path, finding.line),
      ),
      ...verdict.allowlistErrors.map((failure) => workflowCommand("error", failure)),
    ],
    passed: (verdict) => `Shell complexity check passed. ${census(verdict)}`,
    failed: (count) => `${count} finding(s). Shell is a straight line of commands; ${REMEDY}.`,
  });
}
