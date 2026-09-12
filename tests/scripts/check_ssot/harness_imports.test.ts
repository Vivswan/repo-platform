import { describe, expect, test } from "bun:test";
import {
  HARNESS_ROOT,
  harnessImportMismatches,
  IN_PROCESS_SCRIPT_IMPORTS,
  type InProcessScriptImport,
  resolvedImport,
} from "../../../scripts/check/ssot/harness_imports.ts";
import { read, walkFiles } from "../../../scripts/check/ssot/inputs.ts";

const LEG = "tests/ci/sync_end_to_end/13_probe.test.ts";
const CLEAN_LEG = [
  'import { test } from "bun:test";',
  'import { join } from "node:path";',
  'import { parse } from "yaml";',
  'import { boundedSpawn } from "../../shared/bounded_spawn";',
  'import { FIXTURES } from "./fixtures";',
  'const script = new URL("../../../.github/scripts/sync/writer/sync.ts", import.meta.url);',
  'test("x", () => join(script.pathname, parse("a: 1").a, boundedSpawn, FIXTURES));',
].join("\n");

describe("resolvedImport", () => {
  test.each([
    { specifier: "../../shared/temp_dir.ts", resolved: "tests/shared/temp_dir" },
    { specifier: "../../../.github/scripts/sync/x.ts", resolved: ".github/scripts/sync/x" },
    { specifier: "./fixtures", resolved: "tests/ci/sync_end_to_end/fixtures" },
    { specifier: "bun:test", resolved: null },
    { specifier: "node:fs", resolved: null },
    { specifier: "yaml", resolved: null },
  ])("$specifier", ({ specifier, resolved }) => {
    expect(resolvedImport(LEG, specifier)).toBe(resolved);
  });
});

describe("harnessImportMismatches", () => {
  test("tests/**, node:/bun:, packages, and a subprocess path in a string pass", () => {
    expect(harnessImportMismatches({ [LEG]: CLEAN_LEG }, [])).toEqual([]);
  });

  test("an injected import from .github/scripts is a mismatch naming the import", () => {
    const injected = `import { applyUpdate } from "../../../.github/scripts/sync/writer/sync.ts";\n${CLEAN_LEG}`;
    expect(harnessImportMismatches({ [LEG]: injected }, [])).toEqual([
      {
        file: LEG,
        expected: expect.stringContaining("through subprocesses"),
        got: 'an import of "../../../.github/scripts/sync/writer/sync.ts"',
      },
    ]);
  });

  test("every reach shape is caught: type-only, re-export, dynamic import, and require", () => {
    const shapes = [
      'import type { X } from "../../../.github/scripts/sync/a.ts";',
      'export { y } from "../../../.github/scripts/sync/b.ts";',
      'const c = await import("../../../.github/scripts/sync/c.ts");',
      'const d = require("../../../.github/scripts/sync/d.ts");',
    ].join("\n");
    const got = harnessImportMismatches({ [LEG]: `${shapes}\n${CLEAN_LEG}` }, []).map((m) => m.got);
    expect(got).toEqual(
      ["a", "b", "c", "d"].map((n) => `an import of "../../../.github/scripts/sync/${n}.ts"`),
    );
  });

  test("a non-literal specifier and an import escaping the repository fail closed", () => {
    const source = `const m = await import(name);\nimport { z } from "../../../../outside.ts";\n${CLEAN_LEG}`;
    expect(harnessImportMismatches({ [LEG]: source }, []).map((m) => m.got)).toEqual([
      "import() of a non-literal specifier",
      'an import escaping the repository: "../../../../outside.ts"',
    ]);
  });

  test("an allowlisted in-process import passes for its importer only, and a stale entry is loud", () => {
    const entry: InProcessScriptImport = {
      importer: "tests/ci/probe.test.ts",
      script: ".github/scripts/ci/probe",
      reason: "test",
    };
    const source = 'import { f } from "../../.github/scripts/ci/probe";\nf();';
    expect(harnessImportMismatches({ [entry.importer]: source }, [entry])).toEqual([]);
    const elsewhere = 'import { f } from "../../../.github/scripts/ci/probe";\nf();';
    expect(
      harnessImportMismatches({ [LEG]: elsewhere, [entry.importer]: source }, [entry]).map(
        (m) => m.file,
      ),
    ).toEqual([LEG]);
    expect(harnessImportMismatches({ [LEG]: CLEAN_LEG }, [entry])).toEqual([
      {
        file: entry.importer,
        expected: expect.stringContaining(entry.script),
        got: "no such import - stale allowlist entry; remove it",
      },
    ]);
  });

  test("the live tree is clean, and the allowlist is exactly the in-process reaches it carries", () => {
    const files = Object.fromEntries(
      walkFiles(HARNESS_ROOT)
        .filter((f) => !f.symlink && /\.[mc]?[jt]sx?$/.test(f.path))
        .map((f) => [f.path, read(f.path)]),
    );
    expect(harnessImportMismatches(files)).toEqual([]);
    expect(
      harnessImportMismatches(files, [])
        .map((m) => m.file)
        .sort(),
    ).toEqual(IN_PROCESS_SCRIPT_IMPORTS.map((e) => e.importer).sort());
  });
});
