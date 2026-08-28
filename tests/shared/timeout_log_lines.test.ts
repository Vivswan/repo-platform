// Four call sites hand-roll a deadline-expiry log line: they route
// through capture() and re-emit its streams themselves, so proc.ts cannot
// print the expiry for them, and their argv tails can carry values a
// public log must not show (a private slug behind --only or -R, a
// target-derived description). The pinned rule: the logged text names the
// PROGRAM ONLY - command[0] interpolated, or a literal program name -
// never any other interpolation. Source-level pins, not behavioral: the
// sites run under the default hang bound, which no test can wait out.
// When a redacting variant in proc.ts absorbs these lines, it takes these
// pins with it.
//
// The scan is regex over comment-stripped source, not a parse, so its
// error direction matters: everything that escapes the GUARD shape
// (renamed variable, block form, an over-eager comment strip) lands on
// the existence assertion and fails RED. The negative controls below keep
// that direction pinned. Recorded residual: a decoy guard embedded in a
// template-literal STRING in one of the four files would still count -
// that requires writing such a string into a production script, which is
// itself reviewable code.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITES = [
  ".github/scripts/sync/clean_renders.ts",
  ".github/scripts/sync/disarm_pr.ts",
  ".github/scripts/fleet/discovery.ts",
  ".github/scripts/fleet/select_settings_repos.ts",
];

/** The expiry guard; captures the FULL console.error argument list. */
const GUARD = /^\s*if \((?:proc|matrix)\.timedOut\) console\.error\((.*)\);$/gm;
/** The whole argument list must be ONE literal naming the program only: a
 * plain double-quoted string, or a template literal whose sole
 * interpolation is ${command[0]} with nothing but plain text after it. A
 * second argument, a concatenation, or any other interpolation
 * (command.join, args, target) falls outside this shape. */
const PROGRAM_ONLY = /^(?:"[^"]*"|`\$\{command\[0\]\}[^`$]*`)$/;

/** Whole-line // comments and block comments removed, so a decoy guard in
 * a comment cannot satisfy the existence check. Trailing // comments stay
 * (stripping them could eat string content like URLs), which is safe:
 * GUARD anchors at line start, so a trailing-comment decoy never matches.
 * The likely error direction is losing matches (an over-eager strip fails
 * red on the existence check, not green); inventing a match takes
 * adversarial source - an inline block comment prefixing a guard-shaped
 * line - which falls under the header's recorded residual. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every expiry guard's console.error argument list in `source`. */
function expiryGuards(source: string): string[] {
  return [...stripComments(source).matchAll(GUARD)].map(([, argumentList]) => argumentList ?? "");
}

describe("hand-rolled deadline-expiry log lines", () => {
  for (const rel of SITES) {
    test(`${rel} logs the expiry, naming the program only`, () => {
      const guards = expiryGuards(readFileSync(join(import.meta.dir, "../..", rel), "utf-8"));
      // The loud-expiry line must exist: a silent 124/137 exit would send
      // the operator hunting through a log with no cause named.
      expect(guards.length).toBeGreaterThan(0);
      for (const argumentList of guards) {
        expect(argumentList).toContain("timed out");
        expect(argumentList).toMatch(PROGRAM_ONLY);
      }
    });
  }
});

// The scanner's own negative controls: each vacuous-green and leak shape
// the scan must reject, pinned so the checker is seen failing through the
// same assertions its green runs through.
describe("the expiry-line scan rejects its known evasions", () => {
  test("a real guard is found and passes the program-only shape", () => {
    const found = expiryGuards(
      '    if (proc.timedOut) console.error("gh timed out (proc.ts hang bound)");\n',
    );
    expect(found).toEqual(['"gh timed out (proc.ts hang bound)"']);
    expect(found[0]).toMatch(PROGRAM_ONLY);
  });

  test("decoy guards in comments do not satisfy the existence check", () => {
    expect(expiryGuards('  // if (proc.timedOut) console.error("gh timed out");\n')).toEqual([]);
    expect(expiryGuards('/*\nif (proc.timedOut) console.error("gh timed out");\n*/\n')).toEqual([]);
  });

  test("argv-leaking argument lists fail the program-only shape", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal leaking source under test
    expect('`${command.join(" ")} timed out`').not.toMatch(PROGRAM_ONLY);
    expect('"timed out", command.join(" ")').not.toMatch(PROGRAM_ONLY);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal leaking source under test
    expect("`${command[0]} timed out: ${target}`").not.toMatch(PROGRAM_ONLY);
    expect('"timed out: " + command.join(" ")').not.toMatch(PROGRAM_ONLY);
  });

  test("a reshaped guard escapes the scan and must therefore fail red on existence", () => {
    // Renamed variable and block form are OUTSIDE the GUARD shape on
    // purpose: they yield zero guards, which the per-file test turns into
    // a loud failure - never a silent pass over an unexamined line.
    expect(expiryGuards('if (r.timedOut) console.error("gh timed out");\n')).toEqual([]);
    expect(expiryGuards('if (proc.timedOut) {\n  console.error("gh timed out");\n}\n')).toEqual([]);
  });
});
