#!/usr/bin/env bun
// The judge is the CI action's commitlint (actions/validate-commit-names/commitlint.ts), so a refusal here reads as the
// commit-names job's would after the push; the gate passes when either message git could store passes (below).
// Motivating failure: `docs(all-green,build-provenance): ...`, a comma in the scope,
// passed every local gate (pre-commit runs before the message exists) and reddened main.
//
// Usage (wired by .husky/commit-msg):
//   bun scripts/check/check_commit_subject.ts <commit-msg-file>

import { execFileSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { commitlint } from "../../actions/validate-commit-names/commitlint.ts";

// Git cleans the message AFTER this hook and the mode is unknowable here, so both messages it could store are judged
// and the gate refuses only when neither passes (commitlint's own --edit strips comments unconditionally and reads a
// rebase squash message, comments first, as having no header). The diff a `commit -v` buffer carries below the
// scissors line is cut first: it is never part of the message, and past 1 MiB it bursts the stripspace pipe.
//
//   editor commit   -> git stripspace --strip-comments, honoring core.commentChar
//   git commit -m   -> git stripspace: whitespace only, a comment line survives as the subject
//
// The scissors line opens with git's comment marker, never a letter or digit: `fix: ---- >8 ----` is a subject.
const SCISSORS_LINE = /^[^\sA-Za-z0-9]+ -{24} >8 -{24}$/m;

export function candidates(raw: string): string[] {
  const cut = SCISSORS_LINE.exec(raw);
  const message = cut === null ? raw : raw.slice(0, cut.index);
  const cleaned = (flags: string[]): string =>
    execFileSync("git", ["stripspace", ...flags], { input: message, encoding: "utf8" });
  return [...new Set([cleaned(["--strip-comments"]), cleaned([])])].filter((text) => text !== "");
}

export function main(argv: string[]): number {
  const messagePath = argv[0];
  if (!messagePath || argv.length !== 1) {
    console.error("usage: bun scripts/check/check_commit_subject.ts <commit-msg-file>");
    return 2;
  }
  const reports: string[] = [];
  for (const candidate of candidates(readFileSync(messagePath, "utf-8"))) {
    const verdict = commitlint([], candidate);
    if (verdict.status === 0) return 0;
    reports.push(verdict.report);
  }
  // The first candidate's report is the editor-mode one, the subject shown without the comment block behind it.
  writeSync(1, reports[0] ?? "commit-subject: REFUSED, the message is empty\n");
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
