// The workflow scripts forward captured child streams with writeSync,
// never process.stdout.write / process.stderr.write: those are async on
// pipe-backed stdio (the Actions runner shape), and a process.exit
// anywhere later in the run drops everything past the pipe buffer
// (measured at 64 KiB on bun 1.3.14, 128 KiB on 1.4.0). Members of this
// class kept surfacing one landing at a time; this scan makes the next
// one loud at authoring time instead of silent at truncation time.
//
// The scan is regex over comment-stripped source (same approach and
// error-direction reasoning as timeout_log_lines.test.ts): a file whose
// async writes all come after its last exit-capable call drains them on
// natural exit and may stay async, but it must be allowlisted here, and
// the control test pins that ordering so the entry cannot go stale.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS_ROOT = join(import.meta.dir, "../../.github/scripts");

/** Files allowed to keep async stream writes: every exit-capable call
 * precedes the first async write, so the writes ride to a natural exit,
 * which drains. The control test pins that ordering. */
const NATURAL_EXIT_FILES = new Set(["sync/open_pr.ts"]);

const ASYNC_WRITE = /process\.(?:stdout|stderr)\.write\(/;
/** The common exiting constructs: process.exit itself and the helpers
 * that call it (gha's fail/requireEnv, proc's must/mustCapture). Not a
 * proof - an unlisted exiting helper stays a reviewable residual. */
const EXIT_CAPABLE = /process\.exit\b|\bfail\(|\brequireEnv\(|\bmust\(|\bmustCapture\(/;

/** Whole-line // comments and block comments removed, so a mention in a
 * comment neither trips the ban nor satisfies the controls. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS_ROOT, { recursive: true })
    .map(String)
    .filter((rel) => rel.endsWith(".ts"))
    .sort();
}

describe("forwarded child streams are written synchronously", () => {
  test("no async stream write outside the exit-free allowlist", () => {
    const offenders = scriptFiles().filter(
      (rel) =>
        !NATURAL_EXIT_FILES.has(rel) &&
        ASYNC_WRITE.test(stripComments(readFileSync(join(SCRIPTS_ROOT, rel), "utf-8"))),
    );
    expect(offenders).toEqual([]);
  });

  test("each allowlisted file writes only after its last exit-capable call", () => {
    for (const rel of NATURAL_EXIT_FILES) {
      const source = stripComments(readFileSync(join(SCRIPTS_ROOT, rel), "utf-8"));
      // Existence control: the allowlisted file must still match the ban
      // regex, proving the scan can find the shape (and the entry is not
      // stale).
      const firstWrite = source.search(ASYNC_WRITE);
      expect(firstWrite).toBeGreaterThan(-1);
      // The safety property itself: nothing after the first async write
      // can exit, so the write always rides to a draining natural exit.
      expect(EXIT_CAPABLE.test(source.slice(firstWrite))).toBe(false);
    }
  });
});
