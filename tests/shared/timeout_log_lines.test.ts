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
// The guard shape is read off the AST (ts_extract's parser), so a decoy
// in a comment or a string is not a node at all, and everything that
// falls outside the shape (renamed variable, block form) lands on the
// existence assertion and fails RED. The negative controls below keep
// that direction pinned.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Node } from "ts-morph";
import { parseTs } from "../../scripts/ts_extract.ts";

const SITES = [
  ".github/scripts/sync/clean_renders.ts",
  ".github/scripts/sync/disarm_pr.ts",
  ".github/scripts/fleet/discovery.ts",
  ".github/scripts/fleet/select_settings_repos.ts",
];

/** The whole argument list must be ONE literal naming the program only: a
 * plain double-quoted string, or a template literal whose sole
 * interpolation is ${command[0]} with nothing but plain text after it. A
 * second argument, a concatenation, or any other interpolation
 * (command.join, args, target) falls outside this shape. */
const PROGRAM_ONLY = /^(?:"[^"]*"|`\$\{command\[0\]\}[^`$]*`)$/;

/** Every expiry guard's console.error argument list in `source`: an
 * `if ((proc|matrix).timedOut) console.error(...)` statement - no else,
 * no block - read off the AST. A renamed variable or a block form is
 * OUTSIDE the shape on purpose: it yields zero guards, which the
 * per-file test turns into a loud failure, never a silent pass. */
function expiryGuards(source: string): string[] {
  const guards: string[] = [];
  for (const node of parseTs(source).forEachDescendantAsArray()) {
    if (!Node.isIfStatement(node) || node.getElseStatement() !== undefined) continue;
    const condition = node.getExpression();
    if (!Node.isPropertyAccessExpression(condition) || condition.getName() !== "timedOut") {
      continue;
    }
    const subject = condition.getExpression();
    if (!Node.isIdentifier(subject) || !["proc", "matrix"].includes(subject.getText())) continue;
    const then = node.getThenStatement();
    if (!Node.isExpressionStatement(then)) continue;
    const call = then.getExpression();
    if (!Node.isCallExpression(call) || call.getExpression().getText() !== "console.error") {
      continue;
    }
    guards.push(
      call
        .getArguments()
        .map((argument) => argument.getText())
        .join(", "),
    );
  }
  return guards;
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

  test("decoy guards in comments or strings do not satisfy the existence check", () => {
    expect(expiryGuards('  // if (proc.timedOut) console.error("gh timed out");\n')).toEqual([]);
    expect(expiryGuards('/*\nif (proc.timedOut) console.error("gh timed out");\n*/\n')).toEqual([]);
    expect(
      expiryGuards("const doc = 'if (proc.timedOut) console.error(\"gh timed out\")';\n"),
    ).toEqual([]);
  });

  test("argv-leaking argument lists fail the program-only shape through the extractor itself", () => {
    const leaks = [
      'if (proc.timedOut) console.error(`${command.join(" ")} timed out`);',
      'if (proc.timedOut) console.error("timed out", command.join(" "));',
      "if (proc.timedOut) console.error(`${command[0]} timed out: ${target}`);",
      'if (proc.timedOut) console.error("timed out: " + command.join(" "));',
    ];
    for (const leak of leaks) {
      const [argumentList] = expiryGuards(`${leak}\n`);
      expect(argumentList).toBeDefined();
      expect(argumentList).not.toMatch(PROGRAM_ONLY);
    }
  });

  test("a reshaped guard escapes the scan and must therefore fail red on existence", () => {
    // Renamed variable and block form are OUTSIDE the guard shape on
    // purpose: they yield zero guards, which the per-file test turns into
    // a loud failure - never a silent pass over an unexamined line.
    expect(expiryGuards('if (r.timedOut) console.error("gh timed out");\n')).toEqual([]);
    expect(expiryGuards('if (proc.timedOut) {\n  console.error("gh timed out");\n}\n')).toEqual([]);
  });
});
