// The migration ladder's three ssot rules (scripts/check_ssot.ts), each
// over its model: a consistent synthetic ladder yields nothing, each
// defect yields exactly the mismatches naming it (file, expected, got),
// and the live repository holds every invariant.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIGRATIONS_DIR_REL,
  MIGRATIONS_DOC_REL,
  MIGRATIONS_HARNESS_REL,
  MIGRATIONS_TESTS_REL,
  migrationIdTokens,
  migrationLadderMismatches,
  PRUNED_HEADING,
  RETIRED_SHAPE_SCAN,
  RETIRED_SHAPE_TOKENS,
  retiredShapeMismatches,
  retiredShapeScanFiles,
  rungExport,
  rungSources,
  rungTestShortfall,
  rungTestSpecifier,
  selfContainedMismatches,
} from "../../scripts/check_ssot.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

const rungSource = (id: string, imports = 'import { join } from "node:path";\n') =>
  `${imports}export default {\n  id: "${id}",\n  apply(target: { dir: string }) {\n    return { kind: "verdict", verdict: { kind: "x", note: null } };\n  },\n};\n`;
const testSource = (id: string) =>
  `import { describe, expect, test } from "bun:test";\nimport rung from "${rungTestSpecifier(id)}";\ndescribe("${id}", () => {\n  test("x", () => expect(rung.apply({ dir: "." })).toBeDefined());\n});\n`;
const TEST_EXPECTATION = (id: string) =>
  `a bun:test test() reaching the default import from "${rungTestSpecifier(id)}"`;

const consistent = {
  rungFiles: { "m0001_a.ts": rungSource("m0001_a"), "m0002_b.ts": rungSource("m0002_b") },
  testFiles: { "m0001_a.test.ts": testSource("m0001_a"), "m0002_b.test.ts": testSource("m0002_b") },
  harness: "set -e\nrm old/m0001_a.ts\nrun_ladder\ntest -f moved # m0002_b\n",
  doc: `# Rungs\n\n- \`m0001_a\`: moves\n- \`m0002_b\`: rewrites\n\n${PRUNED_HEADING}\n\n- \`m0000_gone\`: pruned\n\n## After\n\nprose\n`,
};

describe("migrationLadderMismatches", () => {
  test("a consistent ladder yields nothing (the control)", () => {
    expect(migrationLadderMismatches(consistent)).toEqual([]);
  });

  test.each([
    {
      reason: "a file that is not a rung file",
      rungFiles: { ...consistent.rungFiles, "index.ts": "export const x = 1;\n" },
      expected: [
        {
          file: `${MIGRATIONS_DIR_REL}/index.ts`,
          expected: "a rung file named mNNNN_<slug>.ts",
          got: "index.ts",
        },
      ],
    },
    {
      reason: "a misnamed rung (three digits)",
      rungFiles: { ...consistent.rungFiles, "m003_c.ts": rungSource("m003_c") },
      expected: [
        {
          file: `${MIGRATIONS_DIR_REL}/m003_c.ts`,
          expected: "a rung file named mNNNN_<slug>.ts",
          got: "m003_c.ts",
        },
      ],
    },
    {
      reason: "an id that is not the filename",
      rungFiles: { ...consistent.rungFiles, "m0002_b.ts": rungSource("m0002_x") },
      expected: [
        {
          file: `${MIGRATIONS_DIR_REL}/m0002_b.ts`,
          expected: 'export default { id: "m0002_b", apply } (the id is the filename)',
          got: 'id: "m0002_x"',
        },
      ],
    },
    {
      reason: "a named export instead of the default object",
      rungFiles: {
        ...consistent.rungFiles,
        "m0002_b.ts": 'export const rung = { id: "m0002_b", apply() {} };\n',
      },
      expected: [
        {
          file: `${MIGRATIONS_DIR_REL}/m0002_b.ts`,
          expected: 'export default { id: "m0002_b", apply } (the id is the filename)',
          got: "no default-exported object literal with a string id and an apply member",
        },
      ],
    },
    {
      reason: "a default object without apply",
      rungFiles: { ...consistent.rungFiles, "m0002_b.ts": 'export default { id: "m0002_b" };\n' },
      expected: [
        {
          file: `${MIGRATIONS_DIR_REL}/m0002_b.ts`,
          expected: 'export default { id: "m0002_b", apply } (the id is the filename)',
          got: "no default-exported object literal with a string id and an apply member",
        },
      ],
    },
  ])("$reason", ({ rungFiles, expected }) => {
    expect(migrationLadderMismatches({ ...consistent, rungFiles })).toEqual(expected);
  });

  test.each([
    {
      reason: "a rung without a test file",
      testFiles: { "m0001_a.test.ts": testSource("m0001_a") },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0002_b.test.ts`,
          expected: "a unit test file for migration m0002_b",
          got: "none",
        },
      ],
    },
    {
      reason: "a test file for a rung that does not exist",
      testFiles: { ...consistent.testFiles, "m0003_c.test.ts": testSource("m0003_c") },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0003_c.test.ts`,
          expected: "test files only for the rungs on the ladder [m0001_a, m0002_b]",
          got: "a test for m0003_c, which has no rung file",
        },
      ],
    },
    {
      reason: "a test importing a decoy path",
      testFiles: {
        ...consistent.testFiles,
        "m0002_b.test.ts": testSource("m0002_b").replace(
          rungTestSpecifier("m0002_b"),
          "./decoy.ts",
        ),
      },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0002_b.test.ts`,
          expected: TEST_EXPECTATION("m0002_b"),
          got: `no import from "${rungTestSpecifier("m0002_b")}"`,
        },
      ],
    },
    {
      reason: "a test whose only test() is skipped",
      testFiles: {
        ...consistent.testFiles,
        "m0002_b.test.ts": testSource("m0002_b").replace("test(", "test.skip("),
      },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0002_b.test.ts`,
          expected: TEST_EXPECTATION("m0002_b"),
          got: "no enabled test() call (a .skip or .todo, a conditional, or an uncalled function does not count)",
        },
      ],
    },
    {
      reason: "a test that names the rung but never calls apply",
      testFiles: {
        ...consistent.testFiles,
        "m0002_b.test.ts": testSource("m0002_b").replace(
          'expect(rung.apply({ dir: "." }))',
          "expect(void rung)",
        ),
      },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0002_b.test.ts`,
          expected: TEST_EXPECTATION("m0002_b"),
          got: "no enabled test() reaches a call of rung.apply(...) (the rung must be exercised from a test, not merely named)",
        },
      ],
    },
    {
      reason: "a test that names the rung while an uncalled helper calls apply",
      testFiles: {
        ...consistent.testFiles,
        "m0002_b.test.ts": `${testSource("m0002_b").replace(
          'expect(rung.apply({ dir: "." }))',
          "expect(void rung)",
        )}function neverCalled() {\n  rung.apply({ dir: "." });\n}\n`,
      },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0002_b.test.ts`,
          expected: TEST_EXPECTATION("m0002_b"),
          got: "no enabled test() reaches a call of rung.apply(...) (the rung must be exercised from a test, not merely named)",
        },
      ],
    },
    {
      reason: "a class inside the test that shadows the rung import",
      testFiles: {
        ...consistent.testFiles,
        "m0002_b.test.ts": testSource("m0002_b").replace(
          'test("x", () => expect(rung.apply({ dir: "." })).toBeDefined());',
          'test("x", () => {\n    class rung {\n      static apply() {}\n    }\n    rung.apply();\n  });',
        ),
      },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0002_b.test.ts`,
          expected: TEST_EXPECTATION("m0002_b"),
          got: "a declaration or parameter named rung shadows the rung import",
        },
      ],
    },
    {
      reason: "a named function expression whose own name shadows the rung import",
      testFiles: {
        ...consistent.testFiles,
        "m0002_b.test.ts": testSource("m0002_b").replace(
          'test("x", () => expect(rung.apply({ dir: "." })).toBeDefined());',
          'test("x", () => {\n    const helper = function rung() {\n      return rung.apply({ dir: "." });\n    };\n    expect(helper()).toBeDefined();\n  });',
        ),
      },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0002_b.test.ts`,
          expected: TEST_EXPECTATION("m0002_b"),
          got: "a declaration or parameter named rung shadows the rung import",
        },
      ],
    },
    {
      reason: "a named class expression whose own name shadows the rung import",
      testFiles: {
        ...consistent.testFiles,
        "m0002_b.test.ts": testSource("m0002_b").replace(
          'test("x", () => expect(rung.apply({ dir: "." })).toBeDefined());',
          'test("x", () => {\n    const Made = class rung {\n      static apply() {\n        return rung.apply;\n      }\n    };\n    expect(Made.apply()).toBeDefined();\n  });',
        ),
      },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0002_b.test.ts`,
          expected: TEST_EXPECTATION("m0002_b"),
          got: "a declaration or parameter named rung shadows the rung import",
        },
      ],
    },
    {
      reason: "a test that calls apply outside any test",
      testFiles: {
        ...consistent.testFiles,
        "m0002_b.test.ts": `${testSource("m0002_b").replace(
          'expect(rung.apply({ dir: "." }))',
          'expect("m0002_b")',
        )}rung.apply({ dir: "." });\n`,
      },
      expected: [
        {
          file: `${MIGRATIONS_TESTS_REL}/m0002_b.test.ts`,
          expected: TEST_EXPECTATION("m0002_b"),
          got: "no enabled test() reaches a call of rung.apply(...) (the rung must be exercised from a test, not merely named)",
        },
      ],
    },
  ])("$reason", ({ testFiles, expected }) => {
    expect(migrationLadderMismatches({ ...consistent, testFiles })).toEqual(expected);
  });

  test.each([
    {
      reason: "a rung with no harness case",
      input: { harness: "set -e\nrm old/m0001_a.ts\n" },
      expected: [
        {
          file: MIGRATIONS_HARNESS_REL,
          expected: "a upgrade-path harness case naming migration m0002_b",
          got: "none",
        },
      ],
    },
    {
      reason: "a rung missing from the docs list",
      input: { doc: consistent.doc.replace("- `m0002_b`: rewrites\n", "") },
      expected: [
        {
          file: MIGRATIONS_DOC_REL,
          expected: "a docs mention naming migration m0002_b",
          got: "none",
        },
      ],
    },
    {
      reason: "a docs mention of a rung that does not exist",
      input: { doc: `${consistent.doc}- \`m0003_c\`: gone\n` },
      expected: [
        {
          file: MIGRATIONS_DOC_REL,
          expected:
            "mentions only of the rungs on the ladder [m0001_a, m0002_b] outside the pruned list",
          got: "a mention of m0003_c, which has no rung file",
        },
      ],
    },
    {
      reason: "a synthetic rung in the harness is the harness's own business",
      input: { harness: `${consistent.harness}cat > migrations/m9999_probe.ts\n` },
      expected: [],
    },
    {
      reason: "a rung that reuses a pruned rung's number under a new slug",
      input: { doc: consistent.doc.replace("m0000_gone", "m0002_old") },
      expected: [
        {
          file: `${MIGRATIONS_DIR_REL}/m0002_b.ts`,
          expected: "a rung number no pruned rung ever used (numbers are never reused)",
          got: `0002, which the pruned rung m0002_old in ${MIGRATIONS_DOC_REL} used`,
        },
      ],
    },
    {
      reason: "two live rungs sharing a number",
      input: {
        rungFiles: { ...consistent.rungFiles, "m0002_c.ts": rungSource("m0002_c") },
        testFiles: { ...consistent.testFiles, "m0002_c.test.ts": testSource("m0002_c") },
        harness: `${consistent.harness}# m0002_c\n`,
        doc: consistent.doc.replace(
          "- `m0002_b`: rewrites",
          "- `m0002_b`: rewrites\n- `m0002_c`: also",
        ),
      },
      expected: [
        {
          file: `${MIGRATIONS_DIR_REL}/m0002_c.ts`,
          expected: "a rung number no other rung uses",
          got: "0002, which m0002_b already uses",
        },
      ],
    },
    {
      reason: "a pruned rung mentioned outside the pruned list",
      input: { doc: consistent.doc.replace("## After\n\nprose", "## After\n\n`m0000_gone` again") },
      expected: [
        {
          file: MIGRATIONS_DOC_REL,
          expected:
            "mentions only of the rungs on the ladder [m0001_a, m0002_b] outside the pruned list",
          got: "a mention of m0000_gone, which has no rung file",
        },
      ],
    },
    {
      reason: "a docs page without the pruned section (the ledger must exist)",
      input: { doc: "- `m0001_a`: moves\n- `m0002_b`: rewrites\n" },
      expected: [
        {
          file: MIGRATIONS_DOC_REL,
          expected: `a "${PRUNED_HEADING}" section (the ledger of numbers never to reuse)`,
          got: "none",
        },
      ],
    },
  ])("$reason", ({ input, expected }) => {
    expect(migrationLadderMismatches({ ...consistent, ...input })).toEqual(expected);
  });

  test.each([
    ["a method", 'export default { id: "m0001_a", apply() {} };\n', { id: "m0001_a" }],
    ["an arrow", 'export default { id: "m0001_a", apply: () => 1 };\n', { id: "m0001_a" }],
    [
      "a function expression",
      'export default { id: "m0001_a", apply: function () {} };\n',
      { id: "m0001_a" },
    ],
    ["a duplicate apply", 'export default { id: "m0001_a", apply() {}, apply: () => 1 };\n', null],
    ["a shorthand id", 'const id = "m0001_a";\nexport default { id, apply() {} };\n', null],
    ["no apply", 'export default { id: "m0001_a" };\n', null],
    ["a non-function apply", 'export default { id: "m0001_a", apply: 0 };\n', null],
    [
      "a spread beside the members",
      'export default { id: "m0001_a", apply() {}, ...more };\n',
      null,
    ],
    ["a duplicate id", 'export default { id: "m0001_a", apply() {}, id: "m9999_x" };\n', null],
    ["a computed name", 'export default { ["id"]: "m0001_a", apply() {} };\n', null],
    [
      "a variable, not a literal",
      'export default rung;\nconst rung = { id: "m0001_a", apply() {} };\n',
      null,
    ],
  ])(
    "rungExport reads only a plain default object with a literal id and a function apply: %s",
    (_shape, source, expected) => {
      expect(rungExport(source)).toEqual(expected);
    },
  );

  test("id tokens are whole tokens: an id inside a longer id or a word never counts", () => {
    expect([...migrationIdTokens("m0001_a, m0001_a_b, xm0001_a, m0001_a.ts, `m0002_b`")]).toEqual([
      "m0001_a",
      "m0001_a_b",
      "m0002_b",
    ]);
  });

  test("rungTestShortfall accepts a default import beside a type-only import, and apply through an alias", () => {
    const source = `import type { Rung } from "../../../.github/scripts/sync/run_migrations.ts";\nimport type { X } from "${rungTestSpecifier("m0001_a")}";\n${testSource("m0001_a")}`;
    expect(rungTestShortfall(source, "m0001_a")).toBeNull();
    const aliased = source
      .replace('expect(rung.apply({ dir: "." }))', 'expect(typed.apply({ dir: "." }))')
      .replace('describe("m0001_a"', 'const typed: Rung = rung;\ndescribe("m0001_a"');
    expect(rungTestShortfall(aliased, "m0001_a")).toBeNull();
    expect(
      rungTestShortfall(
        source.replace("import rung from", "import { default as rung } from"),
        "m0001_a",
      ),
    ).toBe("the rung import is type-only or names no default import");
  });
});

describe("selfContainedMismatches", () => {
  const expected =
    "imports of node:/bun: specifiers only (a rung runs from its build commit, where nothing else exists)";

  test("node: and bun: imports, static or dynamic, are the whole allowance (the control)", () => {
    const source = rungSource(
      "m0001_a",
      'import { readFileSync } from "node:fs";\nimport { test } from "bun:test";\n' +
        'import path = require("node:path");\ntype Stats = import("node:fs").Stats;\n' +
        'const ffi = await import("bun:ffi");\nconst os = await import(`node:os`);\n' +
        'const fs = require("node:path");\n',
    );
    expect(selfContainedMismatches({ "m0001_a.ts": source })).toEqual([]);
  });

  test.each([
    {
      reason: "a sibling script",
      imports: 'import { x } from "../answers_file.ts";\n',
      got: 'an import of "../answers_file.ts"',
    },
    {
      reason: "a type-only sibling import",
      imports: 'import type { Rung } from "../run_migrations.ts";\n',
      got: 'an import of "../run_migrations.ts"',
    },
    { reason: "a package", imports: 'import { parse } from "yaml";\n', got: 'an import of "yaml"' },
    {
      reason: "a bare builtin without the node: prefix",
      imports: 'import { join } from "path";\n',
      got: 'an import of "path"',
    },
    {
      reason: "a re-export",
      imports: 'export { x } from "../relocate.ts";\n',
      got: 'an import of "../relocate.ts"',
    },
    {
      reason: "a dynamic import of a sibling",
      imports: 'const m = await import("../relocate.ts");\n',
      got: 'an import of "../relocate.ts"',
    },
    {
      reason: "a require of a package",
      imports: 'const y = require("yaml");\n',
      got: 'an import of "yaml"',
    },
    {
      reason: "a computed specifier",
      imports: 'const name = "x";\nconst m = await import(name);\n',
      got: "import() of a non-literal specifier",
    },
    {
      reason: "an import-equals of a sibling",
      imports: 'import x = require("../relocate.ts");\n',
      got: 'an import of "../relocate.ts"',
    },
    {
      reason: "an import() type node",
      imports: 'type R = import("../run_migrations.ts").Rung;\n',
      got: 'an import of "../run_migrations.ts"',
    },
    {
      reason: "the loader factory",
      imports: 'import { createRequire } from "node:module";\n',
      got: 'an import of "node:module"',
    },
    {
      reason: "require taken as a value",
      imports: "const load = require;\n",
      got: "a reach for the loader through `require`",
    },
    {
      reason: "module.require (both names are reaches)",
      imports: 'const m = module.require("../relocate.ts");\n',
      got: ["a reach for the loader through `module`", "a reach for the loader through `require`"],
    },
  ])("$reason is red, naming the specifier", ({ imports, got }) => {
    expect(selfContainedMismatches({ "m0001_a.ts": rungSource("m0001_a", imports) })).toEqual(
      [got]
        .flat()
        .map((reach) => ({ file: `${MIGRATIONS_DIR_REL}/m0001_a.ts`, expected, got: reach })),
    );
  });
});

describe("retiredShapeMismatches", () => {
  const expected =
    "no identifying token of a retired shape outside the migration ladder (no compatibility code outside the ladder; a transition is a rung)";

  test("near misses are clean (the boundary control)", () => {
    expect(
      retiredShapeMismatches({
        "a.ts":
          'const grammar = "managed-region";\nconst tail = "tail-markers";\nlet local_endpoint = 1;\nconst cls = mergeable;\nconst x = "repo-platform:mergeable";\nconst argv = ["pr", "view", "--json", "mergeable"];\n',
      }),
    ).toEqual([]);
  });

  test.each(RETIRED_SHAPE_TOKENS.map((shape) => [shape.name, shape.sample] as const))(
    "a planted %s is red with its file and line",
    (_name, sample) => {
      const text = `line one\nconst planted = ${sample};\nline three\n`;
      expect(retiredShapeMismatches({ "tests/sync/x.test.ts": text })).toEqual([
        { file: "tests/sync/x.test.ts:2", expected, got: sample },
      ]);
    },
  );

  test.each(['entry.class === "mergeable"', '"class": "mergeable"', "class !== 'mergeable'"])(
    "the retired class is caught as a class value: %s",
    (line) => {
      expect(retiredShapeMismatches({ "a.ts": `${line}\n` }).map((m) => m.file)).toEqual([
        "a.ts:1",
      ]);
    },
  );

  // The validator's control plants each manifestEntry and expects the token named back, so an
  // entry that does not spell its own token would pass that control vacuously.
  test.each(
    RETIRED_SHAPE_TOKENS.flatMap((shape) =>
      shape.manifestEntry === undefined
        ? []
        : [[shape.name, shape.manifestEntry, shape.re] as const],
    ),
  )(
    "the manifest entry for %s spells the token and parses as one entry object",
    (_name, entry, re) => {
      expect(entry).toMatch(re);
      expect(typeof (JSON.parse(entry) as { class: unknown }).class).toBe("string");
    },
  );
});

describe("the live repository", () => {
  test("the ladder directory holds rung files only, and every rung is self-contained", () => {
    const files = rungSources();
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(selfContainedMismatches(files)).toEqual([]);
  });

  test("the ladder's sites agree", () => {
    expect(
      migrationLadderMismatches({
        rungFiles: rungSources(),
        testFiles: Object.fromEntries(
          readdirSync(join(REPO_ROOT, MIGRATIONS_TESTS_REL)).map((name) => [
            name,
            readFileSync(join(REPO_ROOT, MIGRATIONS_TESTS_REL, name), "utf-8"),
          ]),
        ),
        harness: readFileSync(join(REPO_ROOT, MIGRATIONS_HARNESS_REL), "utf-8"),
        doc: readFileSync(join(REPO_ROOT, MIGRATIONS_DOC_REL), "utf-8"),
      }),
    ).toEqual([]);
  });

  test("no retired-shape token in the sync, the actions, the scripts, or the tests; the scan covers them", () => {
    const files = retiredShapeScanFiles();
    const paths = Object.keys(files);
    expect(RETIRED_SHAPE_SCAN.dirs).toEqual(
      expect.arrayContaining([
        ".github/scripts",
        ".github/workflows",
        "actions",
        "scripts",
        "tests",
      ]),
    );
    for (const covered of [
      ".github/workflows/reusable-template-sync.yml",
      ".github/scripts/sync/head_manifest.ts",
      MIGRATIONS_HARNESS_REL,
      "actions/shared/grammar.ts",
      "actions/validate-template-report/validator/checks/manifest_parity.ts",
      "scripts/ownership.ts",
      "tests/actions/stamp_manifest.test.ts",
    ]) {
      expect(paths).toContain(covered);
    }
    // The token list and its planted controls are the two files allowed to spell the tokens.
    for (const own of ["scripts/check_ssot.ts", "tests/scripts/migration_ladder_rule.test.ts"]) {
      expect(paths).not.toContain(own);
    }
    expect(paths.some((rel) => rel.startsWith(`${MIGRATIONS_DIR_REL}/`))).toBe(false);
    expect(paths.some((rel) => rel.startsWith(`${MIGRATIONS_TESTS_REL}/`))).toBe(false);
    expect(retiredShapeMismatches(files)).toEqual([]);
  });
});
