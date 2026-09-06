// The one owner of temp fixtures in test files: every directory a test
// makes under os.tmpdir() comes from here and is removed when its file's
// tests are done, whatever they did. The ssot rule temp-dirs-through-helper
// keeps bare mkdtemp out of the test trees; the launcher
// (scripts/run_tests.ts) fails a run that leaves anything behind.
//
// One lifetime, the file's: bun:test binds hooks to the file whose
// collection registers them (a hook registered by a module evaluated
// once serves only its first importer), so each test file calls
// tempDirs() at its top level and takes directories from the result.
// Every directory is fresh, so tests stay isolated without a per-test
// removal, and a shared fixture (a module-level repo, a beforeAll tree)
// needs no second flavour that a call from the wrong place could misuse.

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirs {
  /** A fresh empty directory `${os.tmpdir()}/${prefix}XXXXXX`, removed
   * after the file's last test. The prefix names the suite in the
   * launcher's leftover listing, so keep it specific. */
  dir(prefix: string): string;
}

/** Call once at the top level of a test file (collection time, where
 * bun:test binds hooks to the file). The returned handle mints
 * directories anywhere in the file: module level, hooks, or tests. */
export function tempDirs(): TempDirs {
  const made: string[] = [];
  afterAll(() => {
    const failed: string[] = [];
    for (const dir of made.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        failed.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed.length > 0) {
      throw new Error(`temp fixtures could not be removed:\n${failed.join("\n")}`);
    }
  });
  return {
    dir(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      made.push(dir);
      return dir;
    },
  };
}
