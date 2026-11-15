#!/usr/bin/env bun

// The script exemptions mirror VS Code's "allowed locales": a script's punctuation is allowed only in files carrying that script's text.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import { AmbiguousCharacters, InvisibleCharacters } from "monaco-editor/base/common/strings.js";
import { codeSpan } from "../../.github/scripts/shared/markdown_code.ts";
import { capture, failureDetail } from "../shared/action_runtime.ts";
import { type Outcome, runCheck } from "../shared/check_main.ts";
import { repositoryFiles } from "../shared/repository_files.ts";

/** Directories a repository may track whose files the check still leaves alone: vendored installs, build output, agent state. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".output",
  ".wxt",
  ".astro",
  ".next",
  "dist",
  "build",
  "coverage",
  "htmlcov",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".claude",
  ".codex",
]);

/** .typography-allow is written by the sync in managed repos; .typography-allow.local is repo-owned and never synced. */
const ALLOW_FILES = [".typography-allow", ".typography-allow.local"];

/** The deadline of one `git grep` over the checkout: two of them stay well inside a ten-minute job. */
const GREP_TIMEOUT_MS = 120_000;

/** VS Code's unicode-highlight data, straight from monaco-editor. An empty locale set selects the _common + _default confusables (what VS Code highlights regardless of user locale). */
const AMBIGUOUS = AmbiguousCharacters.getInstance(new Set());

/** CJK sentence punctuation, allowed only in files that also carry CJK text (file-level, not line-level: CJK sentences wrap across lines). U+FF0C deliberately absent: the full-width comma is banned everywhere. */
const CJK_PUNCTUATION = new Set([0x3001, 0x3002, 0x300c, 0x300d]);

/** Hiragana/Katakana, CJK ideographs (+ ext A), Hangul, compatibility forms. */
const CJK_TEXT = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u;

/** Devanagari block; exempt in files with Devanagari letters. */
const DEVANAGARI_BLOCK = [0x0900, 0x097f];

/** Devanagari letters: the script's presence in a file. */
const DEVANAGARI_TEXT = /[\u0904-\u0939\u0958-\u095F]/u;

/** Escapes, not literals: this file must never fail its own check. */
const FORBIDDEN =
  /[\u00A0\u00AB\u00AD\u00B1\u00B4\u00BB\u00D7\u00F7\u02BC\u2000-\u2015\u2018-\u201F\u2026\u2028-\u202F\u2032-\u2037\u2039\u203A\u2060\u2066-\u2069\u2212\u2248\u3000\uFEFF\uFF01-\uFF5E]/u;

/** Look-alike ranges by name, the first match naming a code point FORBIDDEN caught. */
const RANGES: [number, number, string][] = [
  [0x2018, 0x201f, "curly quote (use ' or \")"],
  [0x2010, 0x2015, "dash look-alike (use -)"],
  [0x2000, 0x200a, "typographic space (use a regular space)"],
  [0x200b, 0x200f, "invisible character (delete it)"],
  [0x202a, 0x202e, "bidi control character (delete it)"],
  [0x2032, 0x2037, "prime/reversed prime (use ' or \")"],
  [0x2066, 0x2069, "bidi control character (delete it)"],
  [0xff01, 0xff5e, "full-width character (use the ASCII form)"],
];

/** Monaco's invisible-control trio (tab is a formatter's domain and \n never reaches here: lines are split on it), named before the ASCII fast path so it cannot hide them. */
const CONTROL_NAMES: Record<number, string> = {
  11: "vertical tab/form feed (delete it)",
  12: "vertical tab/form feed (delete it)",
  13: "carriage return (use LF line endings)",
};

/** The single confusable characters by name, checked before the ranges. */
const NAMES: Record<number, string> = {
  65292: 'full-width comma (use ", " with a trailing space)',
  160: "non-breaking space (use a regular space)",
  8239: "narrow non-breaking space (use a regular space)",
  12288: "ideographic space (use a regular space)",
  173: "soft hyphen (delete it)",
  8288: "word joiner (delete it)",
  65279: "byte-order mark (delete it)",
  8232: "line separator (use a newline)",
  8233: "paragraph separator (use a newline)",
  8230: 'ellipsis (use "...")',
  8722: "minus sign look-alike (use -)",
  215: 'multiplication sign (use "x")',
  247: 'division sign (use "/")',
  177: 'plus-minus sign (use "+/-")',
  8776: 'almost-equal sign (use "~")',
  171: "guillemet (use quotes)",
  187: "guillemet (use quotes)",
  8249: "guillemet (use quotes)",
  8250: "guillemet (use quotes)",
  8242: "prime (use ')",
  8243: 'double prime (use ")',
  700: "modifier apostrophe (use ')",
  180: "acute accent used as apostrophe (use ')",
};

/** What every failing run tells the reader to do. */
const REMEDY = `Replace each with its plain ASCII form, or exempt the path in ${ALLOW_FILES[1]}.`;

function hex(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

type ScriptContext = { cjk: boolean; devanagari: boolean };

/** One refused character; `line` is 1-based. */
interface Finding {
  path: string;
  line: number;
  what: string;
}

interface Verdict {
  /** Every refused character, in file order. */
  findings: Finding[];

  /** How many text files were read: a count of zero says the check judged nothing. */
  judged: number;
}

function isExempt(relPath: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => relPath.startsWith(prefix));
}

function violation(code: number, context: ScriptContext): string | null {
  const control = CONTROL_NAMES[code];
  if (control !== undefined) return control;

  if (code <= 0x7e) return null;

  if (CJK_PUNCTUATION.has(code)) {
    return context.cjk ? null : `CJK punctuation ${hex(code)} in a non-CJK file (use ASCII)`;
  }

  if (context.devanagari && code >= DEVANAGARI_BLOCK[0] && code <= DEVANAGARI_BLOCK[1]) {
    return null;
  }

  if (NAMES[code]) return NAMES[code];

  if (FORBIDDEN.test(String.fromCodePoint(code))) {
    const range = RANGES.find(([lo, hi]) => code >= lo && code <= hi);
    return range?.[2] ?? `disallowed character ${hex(code)}`;
  }

  if (InvisibleCharacters.isInvisibleCharacter(code)) {
    return `invisible character ${hex(code)} (delete it)`;
  }

  const twin = AMBIGUOUS.getPrimaryConfusable(code);
  if (twin !== undefined) {
    const ascii = twin === 0x20 ? "a regular space" : `"${String.fromCodePoint(twin)}"`;
    return `ambiguous character ${hex(code)} (use ${ascii})`;
  }

  return null;
}

/** The path prefixes the allow files exempt, blank and `#` lines dropped. */
function allowedPrefixes(root: string): string[] {
  return ALLOW_FILES.map((file) => join(root, file))
    .filter((file) => existsSync(file))
    .flatMap((file) => readFileSync(file, "utf-8").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The paths one `git grep -I` lists: the files with a line that git reads as text. */
function grepText(root: string, scope: string[]): string[] {
  // Each --no-* flag answers a user's git config that would change the listing or refuse the grep:
  //   color.grep         -> paths wrapped in escape codes
  //   grep.fullName      -> paths rooted at the repository instead of `root`
  //   submodule.recurse  -> "--untracked not supported with --recurse-submodules"
  const stable = ["--no-color", "--no-full-name", "--no-recurse-submodules"];
  const args = ["-C", root, "grep", "-I", "-l", "-z", ...stable, ...scope];
  const listed = capture(["git", ...args, "-e", ""], { timeoutMs: GREP_TIMEOUT_MS });
  // Exit 1 is git grep's "no file has a line".
  const answered = listed.exit.kind === "exited" && listed.exit.code <= 1;
  if (!answered) throw new Error(`git grep failed in ${root}: ${failureDetail(listed)}`);

  return listed.stdout.split("\0");
}

/** The repository's files git itself reads as text (no NUL byte, no `binary` or `-diff` attribute), whatever their
 *  name. An empty file has no line and is not listed. */
function textFiles(root: string): string[] {
  // Two greps: --untracked drops a tracked file an ignore rule matches, which the plain one lists.
  const text = new Set([...grepText(root, []), ...grepText(root, ["--untracked"])]);
  return repositoryFiles(root, { untracked: true }).filter((relPath) => text.has(relPath));
}

function check(root: string): Verdict {
  const prefixes = allowedPrefixes(root);
  const judged = textFiles(root).filter((relPath) => {
    const dirs = relPath.split("/").slice(0, -1);
    return !dirs.some((dir) => SKIP_DIRS.has(dir)) && !isExempt(relPath, prefixes);
  });

  const findings: Finding[] = [];
  for (const path of judged) {
    const content = readFileSync(join(root, path), "utf-8");
    const context = { cjk: CJK_TEXT.test(content), devanagari: DEVANAGARI_TEXT.test(content) };
    content.split("\n").forEach((line, index) => {
      for (const ch of line) {
        const what = violation(ch.codePointAt(0)!, context);
        if (what) findings.push({ path, line: index + 1, what });
      }
    });
  }

  return { findings, judged: judged.length };
}

function outcomeOf(verdict: Verdict): Outcome<Verdict> {
  return { state: verdict.findings.length > 0 ? "findings" : "clean", verdict };
}

/** A table cell's text: a pipe would end the cell (`use "|"` is a real remedy). */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function report(outcome: Outcome<Verdict>): string {
  const parts = ["## Typography check", ""];
  if (outcome.state === "error") {
    parts.push(`The check did not run to completion: ${outcome.message}`);
    return `${parts.join("\n")}\n`;
  }

  const { findings, judged } = outcome.verdict;
  if (outcome.state === "clean") {
    parts.push(`No look-alike or invisible character in ${judged} text file(s).`);
    return `${parts.join("\n")}\n`;
  }

  parts.push(
    `${findings.length} occurrence(s) in ${judged} text file(s). ${REMEDY}`,
    "",
    "| Where | Character |",
    "| --- | --- |",
    ...findings.map(
      ({ path, line, what }) => `| ${cell(codeSpan(`${path}:${line}`))} | ${cell(what)} |`,
    ),
  );
  return `${parts.join("\n")}\n`;
}

if (import.meta.main) {
  await runCheck<Verdict>(
    {
      name: "check-typography",
      check,
      outcomeOf,
      report,
      warnings: () => [],
      errors: (verdict) =>
        verdict.findings.map(({ path, line, what }) => ({
          message: `${path}:${line} ${what}`,
          file: path,
          line,
        })),
      passed: (verdict) => `Typography check passed (${verdict.judged} text file(s) judged).`,
      failed: (count) => `${count} occurrence(s). ${REMEDY}`,
    },
    core,
  );
}
