// The one owner of temp fixtures in test files: `const temp = tempDirs()`
// at a file's top level, `temp.dir(prefix)` anywhere in it, and one
// afterAll removes everything the file made, whatever its tests did.
//
// One lifetime, the file's, because bun:test binds hooks to the file
// whose collection registers them (a hook registered by a module
// evaluated once serves only its first importer). Fresh directories keep
// tests isolated without a per-test flavour. Known gap, pinned by
// tests/shared/temp_dir.test.ts: bun runs no hook in a file whose tests a
// name filter (-t) all skipped, so such fixtures outlive the process; the
// launcher's per-run TMPDIR is what removes them.

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
