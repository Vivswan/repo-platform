#!/usr/bin/env bun

// Guards against typographic look-alike and invisible characters that
// sneak in via copy-paste or generated text. Vendored from cloud-speech
// and generalized: scans the directory given as argv[2] (default: cwd),
// with path-prefix exemptions read from .typography-allow
// (template-managed in synced repos) and .typography-allow.local
// (repo-owned, never synced).
//
// The forbidden set is the union of the explicit tables below (RANGES,
// NAMES, FORBIDDEN) and VS Code's unicode-highlight data imported from
// the monaco-editor package (InvisibleCharacters plus the
// AmbiguousCharacters confusables). Context exemptions mirror VS Code's
// "allowed locales": CJK sentence punctuation is allowed only in files
// carrying CJK text, Devanagari only in files carrying Devanagari text;
// the full-width comma U+FF0C is banned everywhere (use ", ").
//
// Runs under bun (which executes TypeScript natively) so it can import
// the monaco-editor ESM modules directly.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AmbiguousCharacters, InvisibleCharacters } from "monaco-editor/base/common/strings.js";

const ROOT = resolve(process.argv[2] ?? ".");
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".output",
  ".wxt",
  ".astro",
  ".next",
  "dist",
  "build",
  "coverage",
  "htmlcov",
  // Cargo build output: gitignored in CI checkouts, but local runs would
  // otherwise scan extensionless build binaries as text.
  "target",
  // VS Code extension test downloads: gitignored, but a local run would
  // scan the downloaded app bundle's extensionless binaries.
  ".vscode-test",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".claude",
  ".codex",
]);
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".astro",
  ".py",
  ".pyi",
  ".yml",
  ".yaml",
  ".json",
  ".jinja",
  ".md",
  ".html",
  ".css",
  ".toml",
  ".cfg",
  ".ini",
  ".txt",
  ".template",
  ".sh",
  ".bashrc",
  ".zsh",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ps1",
  ".psm1",
  ".psd1",
  ".rs",
  ".mts",
  ".cts",
  ".svg",
  ".xml",
  ".plist",
  ".entitlements",
  ".lock",
]);

/** Extensionless text files (hooks, licenses) are checked too; "forbidden
 *  everywhere" must include .husky/pre-commit and friends. */
function isCheckable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return true;
  return EXTENSIONS.has(name.slice(dot));
}

// Optional per-repo exemption lists: relative path prefixes to skip.
// .typography-allow is template-managed in synced repos;
// .typography-allow.local is repo-owned and never synced.
const ALLOW_FILES = [join(ROOT, ".typography-allow"), join(ROOT, ".typography-allow.local")];
const ALLOWED_PREFIXES = ALLOW_FILES.flatMap((file) =>
  existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
    : [],
);

function isExempt(relPath: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => relPath === prefix || relPath.startsWith(prefix));
}

// VS Code's unicode-highlight data, straight from monaco-editor. An empty
// locale set selects the _common + _default confusables (what VS Code
// highlights regardless of user locale).
const AMBIGUOUS = AmbiguousCharacters.getInstance(new Set());

// CJK sentence punctuation, allowed only in files that also carry CJK text
// (file-level, not line-level: CJK sentences wrap across lines).
// U+FF0C deliberately absent: the full-width comma is banned everywhere.
const CJK_PUNCTUATION = new Set([0x3001, 0x3002, 0x300c, 0x300d]);
// Hiragana/Katakana, CJK ideographs (+ ext A), Hangul, compatibility forms.
const CJK_TEXT = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u;
// Devanagari block; exempt in files with Devanagari letters.
const DEVANAGARI_BLOCK = [0x0900, 0x097f];
const DEVANAGARI_TEXT = /[\u0904-\u0939\u0958-\u095F]/u;

// Escapes, not literals: this file must never fail its own check.
const FORBIDDEN =
  /[\u00A0\u00AB\u00AD\u00B1\u00B4\u00BB\u00D7\u00F7\u02BC\u2000-\u2015\u2018-\u201F\u2026\u2028-\u202F\u2032-\u2037\u2039\u203A\u2060\u2066-\u2069\u2212\u2248\u3000\uFEFF\uFF01-\uFF5E]/u;

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

function hex(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Returns the failure message for a code point, or null when allowed.
 *  `context` carries the file-level script exemptions. */
type ScriptContext = { cjk: boolean; devanagari: boolean };

function violation(code: number, context: ScriptContext): string | null {
  // Control characters: tab is a formatter's domain and \n never reaches here
  // (lines are split on it); the rest of monaco's invisible-control trio is
  // flagged explicitly so the ASCII fast path below can't hide them.
  if (code === 0x0b || code === 0x0c) return "vertical tab/form feed (delete it)";
  if (code === 0x0d) return "carriage return (use LF line endings)";
  if (code <= 0x7e) return null;
  if (CJK_PUNCTUATION.has(code)) {
    return context.cjk ? null : `CJK punctuation ${hex(code)} in a non-CJK file (use ASCII)`;
  }
  if (context.devanagari && code >= DEVANAGARI_BLOCK[0] && code <= DEVANAGARI_BLOCK[1]) {
    return null;
  }
  if (NAMES[code]) return NAMES[code];
  if (FORBIDDEN.test(String.fromCodePoint(code))) {
    for (const [lo, hi, label] of RANGES) {
      if (code >= lo && code <= hi) return label;
    }
    return `disallowed character ${hex(code)}`;
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

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    // Symlinks (e.g. CLAUDE.md -> AGENTS.md) are skipped: their targets are
    // checked directly, and template symlinks may be dangling by design.
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(path);
    } else if (isCheckable(entry)) {
      yield path;
    }
  }
}

const failures: string[] = [];
for (const path of walk(ROOT)) {
  const relPath = relative(ROOT, path);
  if (isExempt(relPath)) continue;
  const content = readFileSync(path, "utf-8");
  const context = { cjk: CJK_TEXT.test(content), devanagari: DEVANAGARI_TEXT.test(content) };
  content.split("\n").forEach((line, index) => {
    for (const ch of line) {
      const message = violation(ch.codePointAt(0)!, context);
      if (message) failures.push(`${relPath}:${index + 1} ${message}`);
    }
  });
}

if (failures.length > 0) {
  console.error("Typographic look-alike characters found:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(`\n${failures.length} occurrence(s). Replace them with plain ASCII equivalents.`);
  process.exit(1);
}
console.log("Typography check passed.");
