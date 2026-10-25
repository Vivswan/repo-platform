#!/usr/bin/env bun

// The member-shape check over a checkout's TypeScript: records.ts reads each file into records and const blocks,
// rules.ts judges them, and the verdict is reported the fleet way through the shared check main.
// Policy: the code-standards skill, Members stand alone.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import { loadAllowlist, staleEntries } from "../shared/allowlist.ts";
import { type Outcome as CheckOutcome, runCheck } from "../shared/check_main.ts";
import { isGenerated, isManaged } from "../shared/managed_header.ts";
import { PLATFORM_NAME } from "../shared/platform.ts";
import { repositoryFiles } from "../shared/repository_files.ts";
import { isTypeScript, parseSource } from "./records.ts";
import { type Finding, judge } from "./rules.ts";

/** The repo-owned allowlist at the checkout root; `.local` is the never-synced suffix. */
export const ALLOWLIST_FILE = ".member-shape-allow.local";

/** What an allowlist entry's `# reason` must satisfy, quoted in the failure for an entry without one. */
export const REASON_RULE =
  "an allowlist entry needs a reason a reader accepts (vendored or upstream-shaped, generated but missed by the header exemption, a shape an external contract fixes)";

/** Directory names whose contents are vendored or generated wholesale, as check-file-size exempts them. */
const EXEMPT_DIRS = new Set(["node_modules", "vendor", "third_party", "goldens", "__snapshots__"]);

/** The one-line fix list every failure ends with. */
const REMEDY = `Add the blank lines, make the comment one line directly above the item, comment every member or none, or list the path in ${ALLOWLIST_FILE} with a '# reason'.`;

/** A tracked path the check reads: TypeScript outside the exempt directories. */
function isJudged(relPath: string): boolean {
  const dirs = relPath.split("/").slice(0, -1);
  return isTypeScript(relPath) && !dirs.some((dir) => EXEMPT_DIRS.has(dir));
}

/** The findings of one file, or null when oxc cannot parse it. */
export function judgeFile(relPath: string, text: string): Finding[] | null {
  const source = parseSource(relPath, text);
  return source === null ? null : judge(relPath, source);
}

/** One finding as the annotations and the failure line spell it: `path:line: rule`. */
export function describe(finding: Finding): string {
  return `${finding.path}:${finding.line}: ${finding.rule}`;
}

/** What one run found, counted the way the report and the annotations present it. */
export interface Verdict {
  /** Findings on files the allowlist does not name. */
  findings: Finding[];

  /** Files oxc could not parse: warned about, never judged. */
  unparsed: string[];

  /** Allowlist defects: entries without a reason, and stale entries. */
  allowlistErrors: string[];

  /** Files skipped for carrying the platform's managed header: a fleet repository cannot fix such a file. */
  managedSkipped: number;

  /** Files skipped for a generated header: the generator is what to fix. */
  generatedSkipped: number;
}

/** The verdict over the checkout at `root`: every tracked TypeScript file judged, the allowlist applied. */
export function check(root: string): Verdict {
  const allow = loadAllowlist(root, ALLOWLIST_FILE, REASON_RULE);
  const findings: Finding[] = [];
  const found = new Set<string>();
  const unparsed: string[] = [];
  let managedSkipped = 0;
  let generatedSkipped = 0;
  for (const relPath of repositoryFiles(root, { untracked: false })) {
    if (!isJudged(relPath)) {
      continue;
    }
    const text = readFileSync(join(root, relPath), "utf-8");
    if (isGenerated(text)) {
      generatedSkipped += 1;
      continue;
    }
    if (isManaged(text)) {
      managedSkipped += 1;
      continue;
    }
    const judged = judgeFile(relPath, text);
    if (judged === null) {
      unparsed.push(relPath);
      continue;
    }
    if (judged.length === 0) {
      continue;
    }
    found.add(relPath);
    if (!allow.allowed.has(relPath)) {
      findings.push(...judged);
    }
  }
  const allowlistErrors = [
    ...allow.failures,
    ...staleEntries(allow, found, ALLOWLIST_FILE, "every record and constant in shape"),
  ];
  return { findings, unparsed, allowlistErrors, managedSkipped, generatedSkipped };
}

/** The three outcomes the action distinguishes (its `report` output). */
export type Outcome = CheckOutcome<Verdict>;

/** `findings` when there is anything to say (a finding, an unparsable file, an allowlist defect), else `clean`. */
export function outcomeOf(verdict: Verdict): Outcome {
  const { findings, unparsed, allowlistErrors } = verdict;
  const silent = findings.length + unparsed.length + allowlistErrors.length === 0;
  return { state: silent ? "clean" : "findings", verdict };
}

/** The Markdown body of the step summary and the sticky comment: the table, the allowlist section, the counts. */
export function report(outcome: Outcome): string {
  const parts = ["## Member shape check", ""];
  if (outcome.state === "error") {
    parts.push(`The check did not run to completion: ${outcome.message}`);
    return `${parts.join("\n")}\n`;
  }
  const { findings, unparsed, allowlistErrors, managedSkipped, generatedSkipped } = outcome.verdict;
  if (outcome.state === "clean") {
    parts.push("Every record and constant is in shape.");
  } else {
    parts.push(`${findings.length} finding(s).`);
    if (findings.length > 0) {
      parts.push(
        "",
        "| File | Line | Rule |",
        "| --- | --- | --- |",
        ...findings.map((finding) => `| \`${finding.path}\` | ${finding.line} | ${finding.rule} |`),
      );
    }
    if (allowlistErrors.length > 0) {
      parts.push("", `### ${ALLOWLIST_FILE}`, "", ...allowlistErrors.map((error) => `- ${error}`));
    }
    if (unparsed.length > 0) {
      parts.push(
        "",
        `${unparsed.length} file(s) oxc could not parse, not judged:`,
        "",
        ...unparsed.map((path) => `- \`${path}\``),
      );
    }
    parts.push(
      "",
      REMEDY.replace(
        `${ALLOWLIST_FILE} with a '# reason'`,
        `\`${ALLOWLIST_FILE}\` with a \`# reason\``,
      ),
    );
  }
  if (managedSkipped > 0) {
    parts.push("", `${managedSkipped} managed file(s) skipped; ${PLATFORM_NAME} owns them.`);
  }
  if (generatedSkipped > 0) {
    parts.push("", `${generatedSkipped} generated file(s) skipped.`);
  }
  return `${parts.join("\n")}\n`;
}

if (import.meta.main) {
  await runCheck<Verdict>(
    {
      name: "check-member-shape",
      check,
      outcomeOf,
      report,
      warnings: (verdict) =>
        verdict.unparsed.map((path) => ({
          message: `${path}: oxc could not parse the file; it is not judged`,
          file: path,
        })),
      errors: (verdict) => [
        ...verdict.findings.map((finding) => ({
          message: describe(finding),
          file: finding.path,
          line: finding.line,
        })),
        ...verdict.allowlistErrors.map((message) => ({ message })),
      ],
      passed: (verdict) =>
        `Member shape check passed (${verdict.unparsed.length} file(s) not parsed, ${verdict.managedSkipped} managed and ${verdict.generatedSkipped} generated file(s) skipped).`,
      failed: (count) => `${count} finding(s). ${REMEDY}`,
    },
    core,
  );
}
