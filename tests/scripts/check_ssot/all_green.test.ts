// The all-green roster rules' pure helpers (scripts/check/ssot/all_green.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  ALL_GREEN_ROSTER,
  allGreenGateMismatches,
  CHECK_RUN_LOOKUP,
  declaredCheckName,
  expandCheckChain,
  rosterMismatches,
} from "../../../scripts/check/ssot/all_green.ts";
import { templateCarries } from "../../../scripts/lib/ts_extract.ts";

describe("the all-green name pins", () => {
  test("declaredCheckName reads only the real exported declaration - comment, string, nested, and concatenation spoofs all throw or are skipped", () => {
    const active = 'export const CHECK_NAME = "all-green";';
    expect(declaredCheckName(`${active}\n`)).toBe("all-green");
    // None of these carries a top-level exported string-literal
    // declaration NODE, so each throws anchor-lost instead of standing in.
    expect(() => declaredCheckName(`// ${active}\n`)).toThrow("verdict check name");
    expect(() => declaredCheckName(`function f() {\n  const CHECK_NAME = "x";\n}\n`)).toThrow(
      "verdict check name",
    );
    expect(() => declaredCheckName(`const doc = '${active}';\n`)).toThrow("verdict check name");
    expect(() => declaredCheckName('export const CHECK_NAME = "all-green" + "-spoof";\n')).toThrow(
      "verdict check name",
    );
    // A neighbouring same-shaped constant is a different anchor.
    expect(() => declaredCheckName('export const OTHER_CHECK_NAME = "copilot";\n')).toThrow(
      "verdict check name",
    );
    // An UNEXPORTED declaration is not the shared constant the gates
    // import - being exported is part of the pinned fact.
    expect(() => declaredCheckName('const CHECK_NAME = "all-green";\n')).toThrow(
      "verdict check name",
    );
  });

  test("declaredCheckName reads the CODE declaration, not a template decoy - same value or not", () => {
    const real = 'export const CHECK_NAME = "real-name";';
    expect(declaredCheckName(`${real}\n`)).toBe("real-name");
    // A decoy inside a multiline template BEFORE the real declaration,
    // carrying the expected value: raw first-match extraction returned
    // the decoy; the AST sees one declaration node and reads it (whose
    // different value the rule then flags).
    const decoyed = `const doc = \`\nexport const CHECK_NAME = "all-green";\n\`;\n${real}\n`;
    expect(declaredCheckName(decoyed)).toBe("real-name");
    // A decoy with NO code declaration behind it is a lost anchor, as
    // is a declaration rewritten off the string-literal form.
    expect(() => declaredCheckName('const doc = `\nexport const CHECK_NAME = "x";\n`;\n')).toThrow(
      "verdict check name",
    );
    expect(() =>
      declaredCheckName('export const CHECK_NAME = ["all", "green"].join("-");\n'),
    ).toThrow("verdict check name");
    // An escaped quote in the value is just a value to the AST; the rule
    // still flags it because the imported CHECK_NAME cannot carry the
    // same bytes vacuously.
    expect(
      declaredCheckName(
        'export const CHECK_NAME = "a\\"b";\nconst doc = `\nexport const CHECK_NAME = "decoy";\n`;\n',
      ),
    ).toBe('a"b');
  });

  test("the lookup pin matches the active template literal and rejects commented or string-embedded copies", () => {
    const line =
      "const url = `repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=latest`;";
    expect(templateCarries(line, CHECK_RUN_LOOKUP)).toBe(true);
    expect(templateCarries(`// ${line}`, CHECK_RUN_LOOKUP)).toBe(false);
    // A double-quoted decoy spells the backtick as an escape, which is
    // not the template shape the pin names.
    expect(
      templateCarries(
        'const doc = "\\`repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}";',
        CHECK_RUN_LOOKUP,
      ),
    ).toBe(false);
  });
});

describe("expandCheckChain", () => {
  const scripts = {
    check: "bun run lint && bun run inner",
    lint: "bun x biome ci .",
    inner: "bun run lint && bun scripts/x.ts",
  };

  test("expands transitively and records reached script names", () => {
    const { text, names } = expandCheckChain(scripts, "check");
    expect([...names].sort()).toEqual(["check", "inner", "lint"]);
    expect(text).toContain("bun x biome");
    expect(text).toContain("bun scripts/x.ts");
  });

  test("a command outside the chain is not reachable", () => {
    const { text } = expandCheckChain(scripts, "lint");
    expect(text).not.toContain("bun scripts/x.ts");
  });
});

describe("rosterMismatches and allGreenGateMismatches", () => {
  const SITE = { jobsFile: ".github/workflows/ci.yml", rosterName: "ALL_GREEN_ROSTER" };

  test("matching roster and gating jobs pass", () => {
    expect(rosterMismatches(["a", "b"], ["a", "b"], SITE)).toEqual([]);
  });

  test("a gating job missing from the roster mismatches", () => {
    const mismatches = rosterMismatches(["a"], ["a", "b"], SITE);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(".github/workflows/ci.yml");
    expect(mismatches[0].expected).toContain("'b'");
  });

  test("a gate REMOVED from ci.yml while still rostered mismatches", () => {
    // The sneaky case the roster exists for: deleting a gate job (and its
    // needs entry) changes nothing the runtime gate can see, so the stale
    // roster entry is what makes the removal loud.
    const mismatches = rosterMismatches(["a", "b"], ["a"], SITE);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toContain("ALL_GREEN_ROSTER");
    expect(mismatches[0].expected).toContain("'b'");
    expect(mismatches[0].got).toContain("no such job");
  });

  test("a duplicate roster entry mismatches", () => {
    const mismatches = rosterMismatches(["a", "a"], ["a"], SITE);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].got).toContain("'a'");
  });

  // A minimal well-shaped ci.yml doc for the gate judgment, mutated per
  // red case below (the negative controls proving the judgment can fail
  // through the same path its green runs through).
  const doc = (yaml: string) => parseYaml(yaml) as Record<string, unknown>;
  const valid = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: echo a }]
  b:
    runs-on: ubuntu-latest
    steps: [{ run: echo b }]
  all-green:
    needs: [a, b]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: ./actions/all-green
        with:
          needs: \${{ toJSON(needs) }}
  post-green:
    needs: [all-green]
    if: needs.all-green.result == 'success' && github.event_name == 'push'
    uses: ./.github/workflows/post-green.yml
`;

  test("the compliant shape passes (downstream jobs exempt from the roster)", () => {
    expect(allGreenGateMismatches(doc(valid), ["a", "b"])).toEqual([]);
  });

  test("a missing all-green job is the one loud mismatch", () => {
    const found = allGreenGateMismatches(doc("jobs:\n  a:\n    steps: []\n"), ["a"]);
    expect(found).toHaveLength(1);
    expect(found[0].expected).toContain("an 'all-green' job");
  });

  test("a needs entry dropped while the job keeps running goes red", () => {
    const found = allGreenGateMismatches(doc(valid.replace("needs: [a, b]", "needs: [a]")), [
      "a",
      "b",
    ]);
    expect(found.some((m) => m.expected.includes("needs exactly the ALL_GREEN_ROSTER"))).toBe(true);
  });

  test("an always() lost, weakened, or replaced goes red", () => {
    for (const mutated of [
      valid.replace("    if: always()\n", ""),
      valid.replace("if: always()", "if: success()"),
      valid.replace("if: always()", "if: always() && github.event_name == 'push'"),
    ]) {
      const found = allGreenGateMismatches(doc(mutated), ["a", "b"]);
      expect(found.some((m) => m.expected.includes("exactly `if: always()`"))).toBe(true);
    }
  });

  test("a lost judgment step or an unwired needs input goes red", () => {
    const stepless = allGreenGateMismatches(
      doc(valid.replace("./actions/all-green", "./actions/decoy")),
      ["a", "b"],
    );
    expect(stepless.some((m) => m.expected.includes("./actions/all-green"))).toBe(true);
    const unwired = allGreenGateMismatches(
      doc(valid.replace("needs: ${{ toJSON(needs) }}", "needs: '{}'")),
      ["a", "b"],
    );
    expect(unwired.some((m) => m.expected.includes("toJSON(needs)"))).toBe(true);
  });

  test("a renamed gate job, a conditioned gating job, or a renamed gating job goes red", () => {
    const renamedGate = allGreenGateMismatches(
      doc(valid.replace("    if: always()", "    name: info-gate\n    if: always()")),
      ["a", "b"],
    );
    expect(renamedGate.some((m) => m.expected.includes("no name: override"))).toBe(true);
    const conditioned = allGreenGateMismatches(
      doc(valid.replace("  a:\n", "  a:\n    if: github.event_name == 'push'\n")),
      ["a", "b"],
    );
    expect(conditioned.some((m) => m.expected.includes("no job-level if: on a gating job"))).toBe(
      true,
    );
    const renamedGating = allGreenGateMismatches(
      doc(valid.replace("  a:\n", "  a:\n    name: info-a\n")),
      ["a", "b"],
    );
    expect(renamedGating.some((m) => m.expected.includes("no job-level name:"))).toBe(true);
  });

  test("a downstream job without the spelled-out gate clause goes red", () => {
    const found = allGreenGateMismatches(
      doc(
        valid.replace(
          "needs.all-green.result == 'success' && github.event_name == 'push'",
          "github.event_name == 'push'",
        ),
      ),
      ["a", "b"],
    );
    expect(found.some((m) => m.expected.includes("needs.all-green.result == 'success'"))).toBe(
      true,
    );
  });

  test("a downstream clause weakened by || or a status function goes red - substring presence is not enough", () => {
    for (const weakened of [
      "needs.all-green.result == 'success' || always()",
      "always() && needs.all-green.result == 'success' && github.event_name == 'push'",
      "needs.all-green.result == 'success' && !cancelled()",
      // The chained comparison: actionlint-valid, and true exactly when
      // the gate FAILED - the exact-clause split is what catches it.
      "needs.all-green.result == 'success' == false && github.event_name == 'push'",
    ]) {
      const found = allGreenGateMismatches(
        doc(
          valid.replace(
            "needs.all-green.result == 'success' && github.event_name == 'push'",
            weakened,
          ),
        ),
        ["a", "b"],
      );
      expect(found.some((m) => m.expected.includes("&&-only"))).toBe(true);
    }
  });

  test("a conditioned or softened gate step, and a matrixed gate, go red", () => {
    const conditionedStep = allGreenGateMismatches(
      doc(
        valid.replace(
          "      - uses: ./actions/all-green",
          "      - if: false\n        uses: ./actions/all-green",
        ),
      ),
      ["a", "b"],
    );
    expect(conditionedStep.some((m) => m.expected.includes("no if: or continue-on-error:"))).toBe(
      true,
    );
    const softened = allGreenGateMismatches(
      doc(
        valid.replace(
          "      - uses: ./actions/all-green",
          "      - continue-on-error: true\n        uses: ./actions/all-green",
        ),
      ),
      ["a", "b"],
    );
    expect(softened.some((m) => m.expected.includes("no if: or continue-on-error:"))).toBe(true);
    const matrixed = allGreenGateMismatches(
      doc(
        valid.replace(
          "    if: always()",
          "    if: always()\n    strategy:\n      matrix:\n        x: [1]",
        ),
      ),
      ["a", "b"],
    );
    expect(matrixed.some((m) => m.expected.includes("no strategy:"))).toBe(true);
  });

  test("the repo gate's needs roster is ARMED: every ALL_GREEN_ROSTER job is needed", () => {
    // The live-file forcing test: dropping a needs entry from the real
    // ci.yml goes red here.
    expect(
      allGreenGateMismatches(
        parseYaml(readFileSync(".github/workflows/ci.yml", "utf-8")) as Record<string, unknown>,
        ALL_GREEN_ROSTER,
      ),
    ).toEqual([]);
  });
});
