#!/usr/bin/env bun
// The grammar and the refusal words live in actions/validate-commit-names/subject.ts, not here: the build branch
// ships actions/ but not scripts/, so the shared module sits inside the action, and a committer reads locally the
// reason CI's commit-names job would print after the push.
// Motivating failure: `docs(all-green,build-provenance): ...`, a comma in the scope,
// passed every local gate (pre-commit runs before the message exists) and reddened main.
//
// Usage (wired by .husky/commit-msg):
//   bun scripts/check/check_commit_subject.ts <commit-msg-file>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isMergeSubject, refusal } from "../../actions/validate-commit-names/subject.ts";

// A commit -v message carries the whole diff; the bound caps the text handed to the stripspace child,
// and the subject is in the first content line anyway.
const CLEANUP_INPUT_BOUND = 1024 * 1024;

function firstContentLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** Git cleans the message AFTER this hook and the mode is unknowable here,
 *  so both subjects it could store are judged; the gate refuses only when neither is valid.
 *  The residual false-pass (candidates diverge and the stored one is invalid, e.g. `-m "#..."`) is CI's to catch.
 *
 *  git commit -m   -> whitespace cleanup only, a comment line survives as the subject
 *  editor commit   -> comment lines stripped too (git stripspace --strip-comments, honoring core.commentChar) */
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
    console.error("usage: bun scripts/check/check_commit_subject.ts <commit-msg-file>");
    return 2;
  }
  const judged = candidateSubjects(readFileSync(messagePath, "utf-8")).map((candidate) => ({
    candidate,
    reason: isMergeSubject(candidate) ? undefined : refusal(candidate),
  }));
  if (judged.some(({ reason }) => reason === undefined)) return 0;
  console.error(
    [
      "commit-subject: REFUSED",
      ...judged.map(({ candidate, reason }) => `- ${JSON.stringify(candidate)}\n  ${reason}`),
    ].join("\n"),
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
