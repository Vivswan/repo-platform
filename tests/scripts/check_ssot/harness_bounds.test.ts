import { describe, expect, test } from "bun:test";
import {
  ABSOLUTE_MARKER,
  boundSites,
  HARNESS_BOUND_HELPER,
  harnessBoundMismatches,
  SCANNED_FILE,
} from "../../../scripts/check/ssot/harness_bounds.ts";

const FILE = "tests/x/y.test.ts";
const IMPORT = 'import { harnessBound } from "../shared/harness_bound";\n';

function resolverOf(files: Record<string, string>) {
  return { source: (rel: string) => files[rel] ?? null };
}

function flagged(source: string, files: Record<string, string> = {}) {
  return harnessBoundMismatches(FILE, source, resolverOf(files)).mismatches.map((m) => ({
    file: m.file,
    got: m.got.startsWith("a plain number") ? "literal" : "unauditable",
  }));
}

type Flagged = { file: string; got: string }[];
const LITERAL = (line: number) => ({ file: `${FILE}:${line}`, got: "literal" });
const UNAUDITABLE = (line: number) => ({ file: `${FILE}:${line}`, got: "unauditable" });

describe("harness-bounds-scale: test and hook timeouts", () => {
  test.each([
    { shape: "test third argument", source: 'test("t", () => {}, 30_000);' },
    { shape: "it third argument", source: 'it("t", () => {}, 30_000);' },
    { shape: "test.each table", source: 'test.each([1])("t", () => {}, 30_000);' },
    { shape: "test.skipIf", source: 'test.skipIf(false)("t", () => {}, 30_000);' },
    { shape: "test.only", source: 'test.only("t", () => {}, 30_000);' },
    { shape: "options object", source: 'test("t", () => {}, { timeout: 30_000, retry: 1 });' },
    {
      shape: "options object with a quoted key",
      source: 'test("t", () => {}, { "timeout": 30_000 });',
    },
    { shape: "beforeAll second argument", source: "beforeAll(() => {}, 20_000);" },
    { shape: "afterEach second argument", source: "afterEach(() => {}, 20_000);" },
    { shape: "setDefaultTimeout", source: "setDefaultTimeout(1_000);" },
    { shape: "jest.setTimeout", source: "jest.setTimeout(1_000);" },
    { shape: "negated literal", source: 'test("t", () => {}, -30_000);' },
    { shape: "literal arithmetic", source: 'test("t", () => {}, 2 * 15_000);' },
    { shape: "local const", source: 'const T = 20_000;\ntest("t", () => {}, T);' },
    {
      shape: "local const through arithmetic",
      source: 'const SPAWN_MS = 15_000;\ntest("t", () => {}, 2 * SPAWN_MS);',
    },
    {
      shape: "const chain",
      source: 'const A = 15_000;\nconst B = A + 5_000;\ntest("t", () => {}, B);',
    },
    {
      shape: "let reassigned to a number after a scaled initializer",
      source: `${IMPORT}let T = harnessBound(1_000);\nT = 100;\ntest("t", () => {}, T);`,
    },
  ])("a $shape written as a number is flagged on the value's line", ({ source }) => {
    const lines = source.split("\n");
    expect(flagged(source)).toEqual([LITERAL(lines.length)]);
  });

  test.each([
    { shape: "harnessBound call", source: `${IMPORT}test("t", () => {}, harnessBound(30_000));` },
    {
      shape: "scaled arithmetic",
      source: `${IMPORT}test("t", () => {}, 2 * harnessBound(15_000));`,
    },
    {
      shape: "local const holding harnessBound",
      source: `${IMPORT}const T = harnessBound(20_000);\ntest("t", () => {}, T);`,
    },
    {
      shape: "options object holding harnessBound",
      source: `${IMPORT}test("t", () => {}, { timeout: harnessBound(30_000) });`,
    },
    {
      shape: "setDefaultTimeout holding harnessBound",
      source: `${IMPORT}setDefaultTimeout(harnessBound(1_000));`,
    },
    { shape: "options object without a timeout", source: 'test("t", () => {}, { retry: 2 });' },
    {
      shape: "options object held in a variable, holding harnessBound",
      source: `${IMPORT}const opts = { timeout: harnessBound(30_000) };\ntest("t", () => {}, opts);`,
    },
    {
      shape: "options object held in a variable, without a timeout",
      source: 'const opts = { retry: 2 };\ntest("t", () => {}, opts);',
    },
    {
      shape: "scaled base referenced by two bindings of one name",
      source: `${IMPORT}const BASE = harnessBound(1_000);\nlet T = BASE;\nif (x) T = BASE * 2;\ntest("t", () => {}, T);`,
    },
    { shape: "no third argument", source: 'test("t", () => {});' },
    { shape: "mention in a comment", source: '// test("t", () => {}, 30_000);' },
    { shape: "mention in a string", source: "const doc = 'test(\"t\", () => {}, 30_000)';" },
    { shape: "describe (bun takes no timeout there)", source: 'describe("d", () => {}, 30_000);' },
  ])("a $shape passes", ({ source }) => {
    expect(flagged(source)).toEqual([]);
  });

  test("an unauditable value fails closed: a package import, a property read, another call, a spread, a parameter", () => {
    const source = [
      'import { T } from "some-package";',
      'test("a", () => {}, T);',
      'test("b", () => {}, config.timeout);',
      'test("c", () => {}, Number(process.env.T));',
      'test("d", () => {}, { ...opts });',
      `${IMPORT.trimEnd()} function f(P = harnessBound(1)) { test("e", () => {}, P); }`,
    ].join("\n");
    expect(flagged(source)).toEqual([
      UNAUDITABLE(2),
      UNAUDITABLE(3),
      UNAUDITABLE(4),
      UNAUDITABLE(5),
      UNAUDITABLE(6),
    ]);
  });

  test("a shadowing declaration is judged too: one literal among the declarations flags the site", () => {
    const source = [
      IMPORT.trimEnd(),
      "const T = harnessBound(1_000);",
      "function f() { const T = 1_000; return T; }",
      'test("t", () => {}, T);',
    ].join("\n");
    expect(flagged(source)).toEqual([LITERAL(4)]);
  });

  test.each<{ shape: string; source: string; expected: Flagged }>([
    {
      shape: "a scaled operand summed or multiplied",
      source: `${IMPORT}test("t", () => {}, 5_000 + harnessBound(1_000) * 2);`,
      expected: [],
    },
    {
      shape: "a scaled left side minus or over a number",
      source: `${IMPORT}test("t", () => {}, harnessBound(10_000) / 2 - 500);`,
      expected: [],
    },
    {
      shape: "a number minus a scaled bound (shrinks under load)",
      source: `${IMPORT}test("t", () => {}, 10_000 - harnessBound(1_000));`,
      expected: [LITERAL(2)],
    },
    {
      shape: "a number over a scaled bound (shrinks under load)",
      source: `${IMPORT}test("t", () => {}, 1_000 / harnessBound(1));`,
      expected: [LITERAL(2)],
    },
    {
      shape: "a remainder",
      source: `${IMPORT}test("t", () => {}, harnessBound(1_000) % 7);`,
      expected: [UNAUDITABLE(2)],
    },
  ])("arithmetic: $shape", ({ source, expected }) => {
    expect(flagged(source)).toEqual(expected);
  });
});

describe("harness-bounds-scale: imported constants", () => {
  const FIXTURES = "tests/x/fixtures.ts";

  test.each<{ holds: string; initializer: string; extra?: string; expected: Flagged }>([
    { holds: "a literal", initializer: "200_000", expected: [LITERAL(2)] },
    { holds: "harnessBound", initializer: "harnessBound(200_000)", expected: [] },
    {
      holds: "a literal through its own import chain",
      initializer: "BASE + 1",
      extra: 'import { BASE } from "./base";',
      expected: [LITERAL(2)],
    },
  ])("a relatively imported const holding $holds is followed into its module", (c) => {
    const files = {
      [FIXTURES]: `${c.extra ?? ""}\n${IMPORT}export const TEST_TIMEOUT_MS = ${c.initializer};\n`,
      "tests/x/base.ts": "export const BASE = 1_000;\n",
    };
    const source = `import { TEST_TIMEOUT_MS } from "./fixtures";\ntest("t", () => {}, TEST_TIMEOUT_MS);`;
    expect(flagged(source, files)).toEqual(c.expected);
  });

  test("an import alias resolves under the exporting name; a missing module fails closed", () => {
    const files = { [FIXTURES]: `${IMPORT}export const T = harnessBound(1);\n` };
    expect(flagged(`import { T as U } from "./fixtures";\ntest("t", () => {}, U);`, files)).toEqual(
      [],
    );
    expect(flagged(`import { T } from "./gone";\ntest("t", () => {}, T);`, files)).toEqual([
      UNAUDITABLE(2),
    ]);
  });

  test("a local declaration does not hide the import of the same name: both are judged", () => {
    const files = { [FIXTURES]: "export const T = 1_000;\n" };
    const source = [
      'import { T } from "./fixtures";',
      IMPORT.trimEnd(),
      "function f() { const T = harnessBound(1_000); return T; }",
      'test("t", () => {}, T);',
    ].join("\n");
    expect(flagged(source, files)).toEqual([LITERAL(4)]);
  });

  test("a default import cannot be followed and fails closed", () => {
    const files = { [FIXTURES]: `${IMPORT}export default harnessBound(1_000);\n` };
    expect(flagged(`import T from "./fixtures";\ntest("t", () => {}, T);`, files)).toEqual([
      UNAUDITABLE(2),
    ]);
  });
});

describe("harness-bounds-scale: spawn timeouts", () => {
  test.each([
    {
      shape: "Bun.spawnSync literal",
      source: 'Bun.spawnSync(["git"], { stdout: "pipe", timeout: 10_000 });',
    },
    { shape: "Bun.spawn literal", source: 'Bun.spawn(["git"], { timeout: 10_000 });' },
    { shape: "quoted key", source: 'Bun.spawnSync(["git"], { "timeout": 10_000 });' },
    { shape: "object form", source: 'Bun.spawnSync({ cmd: ["git"], timeout: 10_000 });' },
    { shape: "local const", source: 'const T = 15_000;\nBun.spawnSync(["git"], { timeout: T });' },
    {
      shape: "shorthand const",
      source: 'const timeout = 15_000;\nBun.spawnSync(["git"], { timeout });',
    },
  ])("a $shape is flagged on the value's line", ({ source }) => {
    const lines = source.split("\n");
    expect(flagged(source)).toEqual([LITERAL(lines.length)]);
  });

  test.each([
    {
      shape: "harnessBound value",
      source: `${IMPORT}Bun.spawnSync(["git"], { timeout: harnessBound(10_000) });`,
    },
    {
      shape: "shorthand holding harnessBound",
      source: `${IMPORT}const timeout = harnessBound(10_000);\nBun.spawnSync(["git"], { timeout });`,
    },
    { shape: "spawn without a timeout", source: 'Bun.spawnSync(["git"], { stdout: "ignore" });' },
    { shape: "spawn with argv only", source: 'const argv = ["git"];\nBun.spawnSync(argv);' },
    { shape: "other receiver", source: 'fake.spawnSync(["git"], { timeout: 10_000 });' },
    { shape: "string mention", source: 'const s = "Bun.spawnSync(cmd, { timeout: 5 })";' },
  ])("a $shape passes", ({ source }) => {
    expect(flagged(source)).toEqual([]);
  });

  test("options held in a variable are read from its declaration; a spread or an unknown object fails closed", () => {
    expect(flagged('const opts = { timeout: 1_000 };\nBun.spawn(["x"], opts);')).toEqual([
      LITERAL(1),
    ]);
    expect(
      flagged(`${IMPORT}const opts = { timeout: harnessBound(1_000) };\nBun.spawn(["x"], opts);`),
    ).toEqual([]);
    expect(flagged('Bun.spawn(["x"], { ...base, stdout: "pipe" });')).toEqual([UNAUDITABLE(1)]);
    expect(flagged('import { opts } from "./opts";\nBun.spawn(["x"], opts);')).toEqual([
      UNAUDITABLE(2),
    ]);
    expect(flagged("Bun.spawnSync(opts);")).toEqual([UNAUDITABLE(1)]);
  });

  test("a spread after the timeout, a variable also imported, and an alias cycle all fail closed", () => {
    expect(
      flagged(`${IMPORT}Bun.spawn(["x"], { timeout: harnessBound(1_000), ...override });`),
    ).toEqual([UNAUDITABLE(2)]);
    expect(
      flagged(
        `import { opts } from "./o";\n${IMPORT}const opts = { timeout: harnessBound(1) };\nBun.spawn(["x"], opts);`,
      ),
    ).toEqual([UNAUDITABLE(4)]);
    const cycle = [
      'import { options } from "./fixture";',
      "const spawnOptions = options;",
      'function run() { const options = spawnOptions; Bun.spawn(["x"], options); }',
    ].join("\n");
    expect(flagged(cycle)).toEqual([UNAUDITABLE(3)]);
  });
});

describe("harness-bounds-scale: wall-clock bounds", () => {
  test.each([
    {
      clock: "Date.now",
      source: "const start = Date.now();\nexpect(Date.now() - start).toBeLessThan(3000);",
    },
    {
      clock: "performance.now",
      source:
        "const t0 = performance.now();\nexpect(performance.now() - t0).toBeLessThanOrEqual(3000);",
    },
    { clock: "Bun.nanoseconds", source: "expect(Bun.nanoseconds() - t0).toBeLessThan(3e9);" },
    {
      clock: "process.hrtime.bigint",
      source: "expect(process.hrtime.bigint() - t0).toBeLessThan(3n);",
    },
    { clock: "new Date", source: "expect(new Date().getTime() - t0).toBeLessThan(3000);" },
    {
      clock: "a const derived from the clock",
      source:
        "const start = Date.now();\nconst elapsed = Date.now() - start;\nexpect(elapsed).toBeLessThan(3000);",
    },
    {
      clock: "a const two steps from the clock",
      source:
        "const end = Date.now();\nconst elapsed = end - start;\nexpect(elapsed).toBeLessThan(3000);",
    },
    {
      clock: "a let assigned from the clock after its declaration",
      source:
        "let elapsed = 0;\nelapsed = Date.now() - start;\nexpect(elapsed).toBeLessThan(3000);",
    },
    {
      clock: "Date.now under .not.toBeGreaterThan (an upper bound)",
      source: "expect(Date.now() - start).not.toBeGreaterThan(3000);",
    },
  ])("a $clock difference under a plain number is flagged on the bound's line", ({ source }) => {
    const lines = source.split("\n");
    expect(flagged(source)).toEqual([LITERAL(lines.length)]);
  });

  test.each([
    {
      shape: "harnessBound bound",
      source: `${IMPORT}expect(Date.now() - start).toBeLessThan(harnessBound(3000));`,
    },
    { shape: "a length, not a clock", source: "expect(body.length).toBeLessThan(60_000);" },
    {
      shape: "a CPU growth ratio",
      source: "expect(growthRatio(input, run)).toBeLessThan(LINEAR_GROWTH_MAX);",
    },
    {
      shape: "a const holding process.cpuUsage",
      source: "const used = process.cpuUsage(start);\nexpect(used.user).toBeLessThan(3000);",
    },
    {
      shape: "toBeGreaterThan on a clock (a lower bound, which load only helps)",
      source: "expect(Date.now() - start).toBeGreaterThan(100);",
    },
    {
      shape: ".not.toBeLessThan on a clock (a lower bound)",
      source: "expect(Date.now() - start).not.toBeLessThan(100);",
    },
    { shape: "a comment mention", source: "// expect(Date.now() - start).toBeLessThan(3000);" },
    {
      shape: "a fixed date, not the clock",
      source: 'expect(new Date("2026-01-01").getMonth()).toBeLessThan(12);',
    },
  ])("a $shape passes", ({ source }) => {
    expect(flagged(source)).toEqual([]);
  });
});

describe("harness-bounds-scale: the absolute marker", () => {
  const SITE = "expect(Date.now() - start).toBeLessThan(3000);";

  test.each<{ where: string; source: string; expected: Flagged }>([
    {
      where: "in a comment on the line",
      source: `${SITE} // ${ABSOLUTE_MARKER} the deadline under test`,
      expected: [],
    },
    {
      where: "in a comment on the line above",
      source: `// ${ABSOLUTE_MARKER} the deadline under test\n${SITE}`,
      expected: [],
    },
    {
      where: "in a block comment ending on the line above",
      source: `/* ${ABSOLUTE_MARKER} the deadline\n   under test */\n${SITE}`,
      expected: [],
    },
    {
      where: "two lines above",
      source: `// ${ABSOLUTE_MARKER} too far\n\n${SITE}`,
      expected: [LITERAL(3)],
    },
    {
      where: "on the line above a multi-line test call",
      source: `test(\n  "t",\n  () => {},\n  // ${ABSOLUTE_MARKER} the bound under test\n  30_000,\n);`,
      expected: [],
    },
    {
      where: "trailing the value inside a multi-line test call",
      source: `test(\n  "t",\n  () => {},\n  30_000, // ${ABSOLUTE_MARKER} the bound under test\n);`,
      expected: [],
    },
    {
      where: "in a string on the line (not a comment)",
      source: `test("${ABSOLUTE_MARKER} label", () => {}, 1000);`,
      expected: [LITERAL(1)],
    },
    {
      where: "in a comment without a reason",
      source: `${SITE} // ${ABSOLUTE_MARKER}`,
      expected: [LITERAL(1)],
    },
    {
      where: "in a block comment leading code on the same line (excuses that line, not the next)",
      source: `/* ${ABSOLUTE_MARKER} the deadline under test */ ${SITE}\n${SITE}`,
      expected: [LITERAL(2)],
    },
  ])("$where", ({ source, expected }) => {
    expect(flagged(source)).toEqual(expected);
  });

  test("the marker only excuses the site it sits on: neither a comment line two sites up nor a trailing marker on the line above", () => {
    expect(flagged(`// ${ABSOLUTE_MARKER} first only\n${SITE}\n${SITE}`)).toEqual([LITERAL(3)]);
    expect(flagged(`${SITE} // ${ABSOLUTE_MARKER} first only\n${SITE}`)).toEqual([LITERAL(2)]);
  });
});

describe("harness-bounds-scale: sites and anchors", () => {
  test("boundSites reports every kind with its verdict and marker, sorted by line", () => {
    const source = [
      IMPORT.trimEnd(),
      'test("t", () => {}, harnessBound(1));',
      "expect(Date.now() - start).toBeLessThan(other);",
      `Bun.spawnSync(["git"], { timeout: 5 }); // ${ABSOLUTE_MARKER} r`,
    ].join("\n");
    expect(boundSites(FILE, source, resolverOf({}))).toEqual([
      { line: 2, kind: "test timeout", verdict: "scaled", marked: false },
      { line: 3, kind: "wall-clock bound", verdict: "unauditable", marked: false },
      { line: 4, kind: "spawn timeout", verdict: "literal", marked: true },
    ]);
    expect(harnessBoundMismatches(FILE, source, resolverOf({})).audited).toBe(3);
  });

  test("the mismatch names the helper and the marker", () => {
    const [only] = harnessBoundMismatches(
      FILE,
      'test("t", () => {}, 5);',
      resolverOf({}),
    ).mismatches;
    expect(only?.expected).toContain(HARNESS_BOUND_HELPER);
    expect(only?.expected).toContain(ABSOLUTE_MARKER);
  });

  test("every extension bun test runs is scanned", () => {
    for (const ext of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
      expect(SCANNED_FILE.test(`tests/x/a.test.${ext}`)).toBe(true);
    }
    expect(SCANNED_FILE.test("tests/x/fixture.json")).toBe(false);
  });

  test("a source with syntax errors throws instead of judging a recovered tree", () => {
    expect(() => boundSites(FILE, 'test("t", () => {}, 5', resolverOf({}))).toThrow(
      "syntax errors",
    );
  });

  test("a JSX test file is refused loudly, not passed unscanned", () => {
    expect(() =>
      boundSites("tests/x/a.test.tsx", 'test("t", () => {}, 5);', resolverOf({})),
    ).toThrow("JSX");
  });
});
