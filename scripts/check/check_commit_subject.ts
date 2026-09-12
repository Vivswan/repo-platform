#!/usr/bin/env bun
// The judge is the CI action's commitlint (actions/validate-commit-names/commitlint.ts), so a refusal here reads as the
// commit-names job's would after the push; the gate passes when either message git could store passes (below).
// Motivating failure: `docs(all-green,build-provenance): ...`, a comma in the scope,
// passed every local gate (pre-commit runs before the message exists) and reddened main.
//
// Usage (wired by .husky/commit-msg):
//   bun scripts/check/check_commit_subject.ts <commit-msg-file>

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { commitlint } from "../../actions/validate-commit-names/commitlint.ts";

// Git cleans the message AFTER this hook and the mode is unknowable here, so both messages it could store are judged
// and the gate refuses only when neither passes (commitlint's own --edit strips comments unconditionally and reads a
// rebase squash message, comments first, as having no header). The diff a `commit -v` buffer carries below the
// scissors line is cut first: it is never part of the message.
//
//   editor commit   -> git stripspace --strip-comments, honoring core.commentChar
//   git commit -m   -> git stripspace: whitespace only, a comment line survives as the subject
//
// Git's cut line opens with its comment marker: core.commentString, else core.commentChar, else `#`; `auto` is picked
// per message from a fixed set, matched here as a whole. Lines are git's, split on `\n` alone: to a multiline regex a
// bare `\r` also starts a line, and a cut there would hand commitlint a subject CI reads whole. A marker this still
// misses leaves the diff in the message, so the stripspace pipe is sized for one rather than burst by it.
const AUTO_MARKERS = "#;@!$%^&|:";
const STRIPSPACE_MAX_BUFFER = 64 * 1024 * 1024;

function commentMarker(): string {
  for (const key of ["core.commentString", "core.commentChar"]) {
    const value = spawnSync("git", ["config", "--get", key], { encoding: "utf8" }).stdout.trim();
    if (value !== "") return value;
  }
  return "#";
}

function scissorsLine(): RegExp {
  const marker = commentMarker();
  const opener = marker === "auto" ? `[${RegExp.escape(AUTO_MARKERS)}]` : RegExp.escape(marker);
  return new RegExp(`^${opener} -{24} >8 -{24}\\r?$`);
}

export function candidates(raw: string): string[] {
  const lines = raw.split("\n");
  const scissors = scissorsLine();
  const cut = lines.findIndex((line) => scissors.test(line));
  const message = cut === -1 ? raw : lines.slice(0, cut).join("\n");
  const cleaned = (flags: string[]): string =>
    execFileSync("git", ["stripspace", ...flags], {
      input: message,
      encoding: "utf8",
      maxBuffer: STRIPSPACE_MAX_BUFFER,
    });
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
