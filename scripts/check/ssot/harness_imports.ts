// The CI harnesses under tests/ci reach the code they verify only through
// subprocesses: an in-process import of a .github/scripts module would
// test the module inside bun-test, not the script CI runs.

import { posix } from "node:path";
import { moduleSpecifiers } from "../../lib/ts_extract.ts";
import type { Mismatch } from "./comparison.ts";
import { read, walkFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

export const HARNESS_ROOT = "tests/ci";
const SCRIPTS_ROOT = ".github/scripts";
const SOURCE_EXTENSION = /\.[mc]?[jt]sx?$/;

export interface InProcessScriptImport {
  /** The importing test, repo-relative. */
  readonly importer: string;
  /** The imported script, repo-relative without its extension. */
  readonly script: string;
  readonly reason: string;
}

/** The unit tests under tests/ci that import a CI script's pure helpers
 *  in-process, one line each with why. Every entry must be observed by
 *  the scan, so a moved test or a dropped import cannot leave a stale
 *  excuse. */
export const IN_PROCESS_SCRIPT_IMPORTS: readonly InProcessScriptImport[] = [
  {
    importer: "tests/ci/bun_setup_smoke.test.ts",
    script: ".github/scripts/ci/bun_setup_smoke",
    reason: "the smoke's plant and judge helpers are pure functions over recorded step outputs",
  },
  {
    importer: "tests/ci/resolve_action_refs.test.ts",
    script: ".github/scripts/ci/resolve_action_refs",
    reason: "collectRefs is the pure ref parser the CI script wraps",
  },
];

/** `specifier` as a repo-relative, extensionless path when it is a relative
 *  import from `importer`; null for packages and node:/bun: builtins. */
export function resolvedImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(importer), specifier));
  return resolved.replace(SOURCE_EXTENSION, "");
}

/** Every reach from a tests/ci file into .github/scripts that is not an
 *  allowlisted in-process import, a non-literal specifier (unauditable, so
 *  closed), and every allowlist entry the scan never observed. */
export function harnessImportMismatches(
  files: Record<string, string>,
  allowed: readonly InProcessScriptImport[] = IN_PROCESS_SCRIPT_IMPORTS,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const expected = `imports from tests/**, node:/bun:, and packages only - a harness reaches ${SCRIPTS_ROOT} through subprocesses (IN_PROCESS_SCRIPT_IMPORTS lists the unit-test exceptions)`;
  const observed = new Set<InProcessScriptImport>();
  for (const [rel, source] of Object.entries(files)) {
    const { literal, nonLiteral } = moduleSpecifiers(source);
    for (const what of nonLiteral) {
      mismatches.push({ file: rel, expected, got: `${what} of a non-literal specifier` });
    }
    for (const specifier of literal) {
      const resolved = resolvedImport(rel, specifier);
      if (resolved === null) continue;
      if (resolved.startsWith("../")) {
        mismatches.push({
          file: rel,
          expected,
          got: `an import escaping the repository: "${specifier}"`,
        });
        continue;
      }
      if (!resolved.startsWith(`${SCRIPTS_ROOT}/`)) continue;
      const entry = allowed.find((e) => e.importer === rel && e.script === resolved);
      if (entry === undefined) {
        mismatches.push({ file: rel, expected, got: `an import of "${specifier}"` });
      } else {
        observed.add(entry);
      }
    }
  }
  for (const entry of allowed) {
    if (!observed.has(entry)) {
      mismatches.push({
        file: entry.importer,
        expected: `an import of ${entry.script} (IN_PROCESS_SCRIPT_IMPORTS excuses it)`,
        got: "no such import - stale allowlist entry; remove it",
      });
    }
  }
  return mismatches;
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const harnessImportRules: Rule[] = [
  {
    name: "ci-harness-imports",
    run: () => {
      const files = walkFiles(HARNESS_ROOT).filter(
        (f) => !f.symlink && SOURCE_EXTENSION.test(f.path),
      );
      if (files.length === 0) throw new Error(`${HARNESS_ROOT}: no harness files - anchor lost`);
      return harnessImportMismatches(Object.fromEntries(files.map((f) => [f.path, read(f.path)])));
    },
  },
];
