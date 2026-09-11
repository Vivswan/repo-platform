// The all-green roster rules' pure helpers (scripts/check/ssot/all_green.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  ALL_GREEN_ACTION,
  ALL_GREEN_ROSTER,
  allGreenGateMismatches,
  bannedSubstitutions,
  CHECK_RUN_LOOKUP,
  callerCeilingMismatches,
  declaredCheckName,
  expandCheckChain,
  FLEET_CALLERS,
  judgeRunBlock,
  judgeSubstitutionMismatches,
  OPERATOR_CALLERS,
  rosterMismatches,
  SKELETON_SOURCE,
  skeletonCi,
} from "../../../scripts/check/ssot/all_green.ts";
import { templateCarries } from "../../../scripts/lib/ts_extract.ts";

describe("the all-green name pins", () => {
  test("declaredCheckName reads only the real exported declaration - every spoof shape throws anchor-lost", () => {
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

  test("a downstream clause weakened by ||, a status function, or a clause outside the alphabet goes red - substring presence is not enough", () => {
    for (const weakened of [
      "needs.all-green.result == 'success' || always()",
      "always() && needs.all-green.result == 'success' && github.event_name == 'push'",
      "success() && needs.all-green.result == 'success' && github.event_name == 'push'",
      // Only a WHOLE !cancelled() clause is allowed; a negation inside
      // another clause is not.
      "needs.all-green.result == 'success' && !failure()",
      "needs.all-green.result == 'success' && !cancelled() || always()",
      // The chained comparison: actionlint-valid, and true exactly when
      // the gate FAILED - the exact-clause split is what catches it.
      "needs.all-green.result == 'success' == false && github.event_name == 'push'",
      // The parenthesized inversion: the split still finds the gate clause
      // inside it, so the closed alphabet is what refuses the fragments.
      "!cancelled() && (true && needs.all-green.result == 'success' && true) == false",
      // A clause outside the alphabet, however harmless it looks.
      "needs.all-green.result == 'success' && github.actor != 'dependabot[bot]'",
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
      expect(found.some((m) => m.expected.includes("an &&-chain of clauses from"))).toBe(true);
    }
  });

  test("a whole !cancelled() clause beside the gate clause passes - it only narrows, and a leg ordered behind a sibling needs it", () => {
    // The docs-site leg's shape: needs the hook as an order edge, gates
    // on the all-green result alone; without !cancelled() GitHub's
    // implied success() would skip it behind a red or skipped hook.
    const ordered = [
      valid.trimEnd(),
      "  docs-site:",
      "    needs: [all-green, post-green]",
      "    if: \"!cancelled() && needs.all-green.result == 'success' && github.event_name == 'push'\"",
      "",
    ].join("\n");
    expect(allGreenGateMismatches(doc(ordered), ["a", "b"])).toEqual([]);
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

describe("the judge's substitution ban", () => {
  // The ban's own controls: a regex regression that let a bracketed
  // probe through, or refused the assignment shapes the judge is
  // written in, would blind the rule silently.
  test.each([
    { line: 'if [ "$(probe)" -gt 0 ]; then', caught: true },
    { line: 'if test "$(probe)" = x; then', caught: true },
    { line: 'case "$(probe)" in', caught: true },
    { line: 'x="$(probe)" trailing_command', caught: true },
    { line: 'x="$(a)$(b)"', caught: true },
    { line: 'count="$(jq length <<<"$x")"', caught: false },
    { line: 'if ! parsed="$(jq -ce . <<<"$x")"; then', caught: false },
    { line: 'x="$(probe)" || exit 1', caught: false },
    // A `)"` inside the jq program is not the substitution's close.
    { line: 'total="$(jq \'error("got \\(type)") end\' <<<"$NEEDS")"', caught: false },
    { line: "n=$((count + 1))", caught: false },
    { line: '# if [ "$(probe)" -gt 0 ]; then', caught: false },
  ])("$line", ({ line, caught }) => {
    expect(bannedSubstitutions(`echo first\n${line}\n`)).toEqual(caught ? [`2:${line}`] : []);
  });

  test("the live judge block is clean; a probe moved into a test bracket, a dropped errexit, or a renamed step goes red", () => {
    const text = readFileSync(ALL_GREEN_ACTION, "utf-8");
    expect(judgeSubstitutionMismatches(text)).toEqual([]);
    const bracketed = text.replace(
      'if [ "$total" -eq 0 ]; then',
      'if [ "$(jq length <<<"$NEEDS")" -eq 0 ]; then',
    );
    expect(bracketed).not.toBe(text);
    const moved = judgeSubstitutionMismatches(bracketed);
    expect(moved).toHaveLength(1);
    expect(moved[0].got).toEndWith(':if [ "$(jq length <<<"$NEEDS")" -eq 0 ]; then');
    const unguarded = text.replace("        set -euo pipefail\n", "");
    expect(judgeRunBlock(unguarded)).not.toContain("set -euo pipefail");
    const dropped = judgeSubstitutionMismatches(unguarded);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].expected).toContain("set -euo pipefail");
    expect(() =>
      judgeSubstitutionMismatches(text.replace("Judge every needed result", "Judge")),
    ).toThrow("anchor lost");
  });
});

describe("callerCeilingMismatches", () => {
  const caller = {
    rel: "ci.yml",
    job: "ci",
    permissions: { "contents": "read", "issues": "read", "pull-requests": "write" },
  };
  const called = (jobs: string) => ({
    rel: "fleet-ci.yml",
    text: `on: workflow_call\njobs:\n${jobs}`,
  });

  test("grants at or under the ceiling pass; a job with no block inherits the caller's", () => {
    const text = [
      "  a:",
      "    permissions:",
      "      contents: read",
      "      pull-requests: write",
      "  b:",
      "    runs-on: ubuntu-latest",
      "",
    ].join("\n");
    expect(callerCeilingMismatches(called(text), caller)).toEqual([]);
  });

  test("a scope above the ceiling, or one the caller omits, goes red naming job and scope", () => {
    const text = [
      "  nightly:",
      "    if: github.event_name == 'schedule'",
      "    permissions:",
      "      contents: read",
      "      issues: write",
      "      security-events: write",
      "",
    ].join("\n");
    const mismatches = callerCeilingMismatches(called(text), caller);
    expect(mismatches.map((m) => [m.file, m.got])).toEqual([
      ["fleet-ci.yml job 'nightly'", "issues: write"],
      ["fleet-ci.yml job 'nightly'", "security-events: write"],
    ]);
    expect(mismatches[0].expected).toContain("issues: at most read");
    expect(mismatches[1].expected).toContain("security-events: at most none");
  });

  test("the called workflow's top-level block is every blockless job's grant", () => {
    const text = "  a:\n    runs-on: ubuntu-latest\n";
    const doc = {
      rel: "fleet-ci.yml",
      text: `on: workflow_call\npermissions:\n  issues: write\njobs:\n${text}`,
    };
    expect(callerCeilingMismatches(doc, caller).map((m) => m.got)).toEqual(["issues: write"]);
  });

  test("a shorthand grant on either side is refused rather than judged", () => {
    expect(
      callerCeilingMismatches(called("  a:\n    permissions: write-all\n"), caller).map(
        (m) => m.got,
      ),
    ).toEqual(["write-all"]);
    expect(
      callerCeilingMismatches(called("  a:\n    runs-on: x\n"), {
        ...caller,
        permissions: "read-all",
      }).map((m) => m.got),
    ).toEqual(["read-all"]);
    expect(
      callerCeilingMismatches(called("  a:\n    runs-on: x\n"), {
        ...caller,
        permissions: undefined,
      }).map((m) => m.got),
    ).toEqual(["no permissions block"]);
  });

  // Both rosters, the fleet's skeleton callers and the operator's own chain (ci.yml's
  // post-green job calling post-green.yml, whose legs call the writers), as one site list.
  const liveSites = [
    ...Object.entries(FLEET_CALLERS).map(([rel, job]) => ({
      rel,
      caller: SKELETON_SOURCE,
      job,
      doc: skeletonCi,
    })),
    ...Object.entries(OPERATOR_CALLERS).map(([rel, caller]) => ({
      rel,
      caller: caller.rel,
      job: caller.job,
      doc: () => parseYaml(readFileSync(caller.rel, "utf-8")) as Record<string, unknown>,
    })),
  ];
  test.each(liveSites)(
    "$rel fits its caller $caller job $job; raising one scope goes red",
    ({ rel, caller, job, doc }) => {
      const callerDoc = doc() as { jobs: Record<string, { permissions?: unknown }> };
      const text = readFileSync(rel, "utf-8");
      const site = { rel: caller, job, permissions: callerDoc.jobs[job].permissions };
      expect(callerCeilingMismatches({ rel, text }, site)).toEqual([]);
      // Every contents: read grant raised at once, at whatever level the workflow spells it: a
      // job's own block shadows the top-level one, so raising only the first could raise nothing.
      const raised = text.replace(/^( *)contents: read$/gm, "$1contents: write");
      expect(raised).not.toBe(text);
      expect(callerCeilingMismatches({ rel, text: raised }, site).length).toBeGreaterThan(0);
    },
  );
});
