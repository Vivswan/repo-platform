// The executable scripts forward captured child streams with writeSync,
// never process.stdout.write / process.stderr.write: those are async on
// pipe-backed stdio (the Actions runner shape), and a process.exit
// anywhere later in the run drops everything past the pipe buffer
// (measured at 64 KiB on bun 1.3.14, 128 KiB on 1.4.0). Members of this
// class kept surfacing one landing at a time; this guard makes the next
// one loud at authoring time instead of silent at truncation time.
//
// ONE scanner on purpose: this suite drives check_ssot.ts's own
// asyncStreamWriteMismatches (AST-read call sites, so strings and
// comments never fire) over the same three roots its stream-write-sync
// rule scans, instead of keeping a second implementation whose semantics
// could silently diverge (the two guards previously carried same-named
// stripComments locals with removal semantics; timeout_log_lines.test.ts
// reads the shared parser for the same reason). The scanner's own
// fixture controls - fire shapes, the allowlist mechanism, stale entries
// - live in tests/scripts/check_ssot.test.ts; what this suite adds is the
// bun-test-side enforcement plus the reach control below.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asyncStreamWriteMismatches, NATURAL_EXIT_WRITE_FILES } from "../../scripts/check_ssot.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

// The executable trees. Tests are excluded by design: tests/ sits outside
// these roots and the actions' co-located *.test.ts files are filtered
// below - bun-test owns a test's process lifecycle, so the
// exit-under-buffered-write truncation is not a shape a test can produce.
const ROOTS = [".github/scripts", "scripts", "actions"];

function scriptFiles(root: string): string[] {
  return readdirSync(join(REPO_ROOT, root), { recursive: true })
    .map(String)
    .filter(
      (rel) =>
        rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !/(^|\/)node_modules\//.test(rel),
    )
    .map((rel) => join(root, rel))
    .sort();
}

describe("forwarded child streams are written synchronously", () => {
  test("every root is really scanned (an empty walk would pass vacuously)", () => {
    for (const root of ROOTS) {
      expect(scriptFiles(root).length).toBeGreaterThan(0);
    }
  });

  test("no stream-write violations across the executable trees", () => {
    const findings = ROOTS.flatMap(scriptFiles).flatMap((rel) =>
      asyncStreamWriteMismatches(
        rel,
        readFileSync(join(REPO_ROOT, rel), "utf-8"),
        NATURAL_EXIT_WRITE_FILES.has(rel),
      ),
    );
    expect(findings).toEqual([]);
  });
});
