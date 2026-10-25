#!/usr/bin/env bun

// Shell may carry one level of a construct; a construct inside another, or a function at any depth, is a TypeScript
// script run by bun. The constructs counted per dialect are the list in action.yml's description.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as core from "@actions/core";
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

/** The repo-owned allowlist at the checkout root; `.local` is the never-synced suffix. */
export const ALLOWLIST_FILE = ".shell-complexity-allow.local";

/** What an allowlist entry's `# reason` must satisfy, quoted in the failure for an entry without one. */
export const REASON_RULE =
  "an allowlist entry needs a reason a reader accepts (the block runs before bun exists, or the file is upstream-shaped)";

/** The fix every finding line ends with. */
export const REMEDY = `move this block to a TypeScript script run by bun, or list the file in ${ALLOWLIST_FILE} with a # reason`;

/** Tracked directories the check leaves alone (vendored installs, build output); a repository's own such directory (a sync writer's templates) is the caller's `skip` input. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "third_party", "dist", "build", ".venv"]);

/** One refused construct. `line` is 1-based; `written` is set when `path` is a template and `line` is the written
 *  tree's. */
export interface Finding {
  path: string;
  line: number;
  construct: string;
  source: SourceKind;
  dialect: Dialect;
  written?: WrittenLine;
}

/** A path of a written tree reported against the template that produced it: the template's line when the two map,
 *  else the written line named as such (a template with no record keeps its path, the tree named beside the line). */
function fromWritten<T extends { path: string; line: number }>(
  item: T,
  written: WrittenTree,
): T & { written?: WrittenLine } {
  // An own record only: a written path named `constructor` must find nothing, not Object's.
  const template = Object.hasOwn(written.templates, item.path)
    ? written.templates[item.path]
    : undefined;
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
  /** Refused constructs on files the allowlist does not name. */
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
 *  to fix; a fleet repository never judges them. `written`: that tree's name and each written file's template, so a
 *  finding points at the template that produced it rather than at a same-named file of the checkout. `skip`: directory
 *  names of the caller's own the check must not read, beside the generic skip set. */
export interface CheckOptions {
  judgeManaged: boolean;
  written?: WrittenTree;
  skip?: readonly string[];
}

/** A written tree by name; `templates` maps each written path to its template, `lineMapped` when the template's
 *  lines are the written file's (no block splice). */
export interface WrittenTree {
  tree: string;
  templates: Record<string, { path: string; lineMapped: boolean }>;
}

/** Set on a remapped item whose `line` is the written tree's, not the template's. */
export interface WrittenLine {
  tree: string;
}

/** A shell source and its kind, or null for a file the check does not read: a kind by name (workflow, action, moon
 *  task, Containerfile), else an extensionless file git tracks whose shebang names a shell. An extensionless file is
 *  shell only by its shebang, and only a tracked one is read: a hook or tool script a tool generates into the checkout
 *  is not the repository's. */
function shellSource(
  root: string,
  relPath: string,
  tracked: ReadonlySet<string>,
): { kind: SourceKind; text: string } | null {
  const named = sourceKindOf(relPath);
  if (named === null && !(tracked.has(relPath) && isExtensionless(relPath))) return null;

  const text = readFileSync(join(root, relPath), "utf-8");
  if (named === null && shebangDialect(text) === null) return null;

  return { kind: named ?? "script", text };
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
  const tracked = new Set(repositoryFiles(root, { untracked: false }));
  for (const relPath of repositoryFiles(root, { untracked: true })) {
    if (!isJudged(relPath, skip)) continue;

    const source = shellSource(root, relPath, tracked);
    if (source === null) continue;

    if (!options.judgeManaged && isManaged(source.text)) {
      managedSkipped += 1;
      continue;
    }

    const collected = collectFile(relPath, source.text);
    counts[source.kind] += collected.bodies.length;
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

/** A `||` construct, or a path with a `|` in it, is a table cell too. */
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
            `| \`${cell(where(finding))}\` | \`${cell(finding.construct)}\` | ${SOURCE_LABEL[finding.source]}, ${DIALECT_LABEL[finding.dialect]} |`,
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

/** `--judge-managed`, `--sources <file>`, and `--skip <names>` are this check's; the root positional is the shared main's. */
function parseFlags(argv: string[]): { options: CheckOptions; rest: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "judge-managed": { type: "boolean" },
      sources: { type: "string" },
      skip: { type: "string" },
    },
    allowPositionals: true,
  });
  const options: CheckOptions = { judgeManaged: values["judge-managed"] ?? false };
  if (values.sources !== undefined) {
    options.written = JSON.parse(readFileSync(values.sources, "utf-8")) as WrittenTree;
  }
  // Comma-separated, the action input's shape; an empty value (the input unset) skips nothing.
  options.skip = values.skip
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return { options, rest: positionals };
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
        verdict.unreadable.map((problem) => ({
          message: `${where(problem)}: ${problem.message}; skipped`,
          file: problem.path,
          line: problem.written === undefined ? problem.line : undefined,
        })),
      errors: (verdict) => [
        ...verdict.findings.map((finding) => ({
          message: describe(finding),
          file: finding.path,
          line: finding.written === undefined ? finding.line : undefined,
        })),
        ...verdict.allowlistErrors.map((message) => ({ message })),
      ],
      passed: (verdict) => `Shell complexity check passed. ${census(verdict)}`,
      failed: (count) =>
        `${count} finding(s). Shell may nest no construct inside another; ${REMEDY}.`,
    },
    core,
    rest,
  );
}
