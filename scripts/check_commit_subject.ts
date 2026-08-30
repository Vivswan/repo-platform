#!/usr/bin/env bun
// Commit-msg-stage gate: judges the pending commit's SUBJECT line against
// the SAME grammar CI's commit-names job enforces
// (actions/validate-commit-names), so a bad subject dies at `git commit`
// instead of going red on main after the push. Motivating failure
// (2026-08-30): `docs(all-green,build-provenance): ...` - a COMMA in the
// scope - passed every local gate (pre-commit runs before the message
// exists) and reddened main.
//
// SINGLE SOURCE: the grammar is imported from
// actions/validate-commit-names/subject.ts, never duplicated. The
// direction is forced by the build branch: it ships actions/ but not
// scripts/, so the shared module must live inside the action to keep it
// self-contained for fleet `uses:` refs, while this hook only runs in a
// full checkout where actions/ exists.
// tests/scripts/check_commit_subject.test.ts proves the hook and the CI
// validator judge identically and reds if the grammar ever forks.
//
// Usage (wired by .husky/commit-msg):
//   bun scripts/check_commit_subject.ts <commit-msg-file>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  allowedTypes,
  conventionalSubject,
  isMergeSubject,
  scopeCharacterClass,
} from "../actions/validate-commit-names/subject.ts";

// The subject sits in the first content line; the bound only limits how
// far the search reaches past leading blanks and comments, and keeps a
// commit -v buffer's multi-megabyte diff out of the child's stdout
// (execFileSync's default maxBuffer dies on it).
const CLEANUP_INPUT_BOUND = 1024 * 1024;

function firstContentLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** The subjects git could store for this message file, deduplicated. Git
 *  applies the message cleanup AFTER the commit-msg hook runs, and the
 *  mode is unknowable here: `git commit -m` cleans whitespace only (the
 *  raw first content line is the subject, comment lines survive), while
 *  editor commits also strip comment lines - delegated to `git
 *  stripspace --strip-comments` (the cleanup's own code path, honoring
 *  core.commentChar) rather than reimplemented. The gate refuses only
 *  when NO mode could store a valid subject; the residual false-pass (a
 *  message whose two candidates diverge and whose stored one is the
 *  invalid one, e.g. `-m "#..."`) is CI-caught - the hook is the local
 *  echo, CI stays authoritative. */
export function candidateSubjects(raw: string): string[] {
  const bounded = raw.slice(0, CLEANUP_INPUT_BOUND);
  const cleaned = execFileSync("git", ["stripspace", "--strip-comments"], {
    input: bounded,
    encoding: "utf8",
    maxBuffer: 8 * CLEANUP_INPUT_BOUND,
  });
  return [...new Set([firstContentLine(bounded), firstContentLine(cleaned)])];
}

export function main(argv: string[]): number {
  const messagePath = argv[0];
  if (!messagePath || argv.length !== 1) {
    console.error("usage: bun scripts/check_commit_subject.ts <commit-msg-file>");
    return 2;
  }
  const candidates = candidateSubjects(readFileSync(messagePath, "utf-8"));
  // Merge commits are exempt exactly as CI exempts them (isMergeSubject).
  const acceptable = (subjectLine: string) =>
    isMergeSubject(subjectLine) || conventionalSubject.test(subjectLine);
  if (!candidates.some(acceptable)) {
    console.error(
      [
        `commit-subject: REFUSED: ${candidates.map((c) => JSON.stringify(c)).join(" / ")}`,
        "The subject must be a Conventional Commit - `<type>(<scope>)?!?: <description>` with",
        `type one of ${allowedTypes.join("|")} and scope drawn from ${scopeCharacterClass}`,
        "(no commas: ONE scope per subject; CI's commit-names job enforces this same grammar,",
        "so a subject refused here would otherwise redden main after the push).",
        "Examples: `feat: add setup flow`, `fix(sync): repair installer`, `feat!: simplify bootstrap`.",
      ].join("\n"),
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
