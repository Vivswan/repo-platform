// process.stdout.write and process.stderr.write are async on pipe-backed stdio (the Actions runner shape),
// so a later process.exit drops everything past the pipe buffer; the executable scripts forward child streams with writeSync.
//   bun 1.3.14  -> 64 KiB pipe buffer measured
//   bun 1.4.0   -> 128 KiB
//
// ONE scanner on purpose: a second implementation could silently diverge from the ssot checker's semantics,
// so this drives its asyncStreamWriteMismatches (scripts/check/ssot/process_discipline.ts) over the roots the stream-write-sync rule scans.
// The scanner's fire shapes and allowlist controls live in tests/scripts/check_ssot/process_discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  asyncStreamWriteMismatches,
  NATURAL_EXIT_WRITE_FILES,
} from "../../scripts/check/ssot/process_discipline.ts";
import { harnessBound } from "./harness_bound";

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
  test(
    "no stream-write violations across the executable trees",
    () => {
      // Reach control first: an empty walk would make the assertion below
      // pass vacuously.
      for (const root of ROOTS) {
        expect(scriptFiles(root).length).toBeGreaterThan(0);
      }
      const findings = ROOTS.flatMap(scriptFiles).flatMap((rel) =>
        asyncStreamWriteMismatches(
          rel,
          readFileSync(join(REPO_ROOT, rel), "utf-8"),
          NATURAL_EXIT_WRITE_FILES.has(rel),
        ),
      );
      expect(findings).toEqual([]);
    },
    // A whole-tree read: 0.4 s idle, but it ran past bun's 5 s default under load.
    harnessBound(30_000),
  );
});
