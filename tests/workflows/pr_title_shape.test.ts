// The fleet squash-merges with the PR title as the subject, and the subject then meets actions/validate-commit-names;
// a title the pr-title check passes but that gate refuses (`fix(sync,writer): ...`, two scopes) lands red on main.
// The commit side of every row is the gate's own path: refusal() on the subject it normalizes (first line, trimmed).
// The title side models MODELED_ACTION's src/validatePrTitle.js on its bundled parser (conventional-commits-parser 6,
// conventional-changelog-conventionalcommits 9.1.0 parser options); a pin bump reds the uses pin below until re-traced:
//   parseHeader             -> the preset's breakingHeaderPattern is tried first; no action input replaces it
//   matched group `|| null` -> a whitespace-only description IS a subject, only "" is refused
//   types (parseEnum)       -> split on newline, trimmed, empties dropped, each wrapped in ^ $
//   subjectPattern          -> must match the WHOLE subject (match[0].length === subject.length)
// Titles are single-line, so multi-line inputs are not rows: on "fix: x\ry" the parser refuses (`.` stops at \r)
// while the gate accepts, and on " fix: x" the parser refuses (no trim) while the gate trims; both are the harmless
// direction, a title refused never lands.
// The root twin is judged too: nothing else pins it to the managed source.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  allowedTypes,
  refusal,
  scopeCharacterClass,
  subject,
} from "../../actions/validate-commit-names/subject.ts";

interface Step {
  uses?: string;
  with?: Record<string, string>;
}

const MODELED_ACTION =
  "amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50";

const PRESET = {
  headerPattern: "^(\\w*)(?:\\((.*)\\))?!?: (.*)$",
  breakingHeaderPattern: "^(\\w*)(?:\\((.*)\\))?!: (.*)$",
  types: "feat\nfix\ndocs\nstyle\nrefactor\nperf\ntest\nbuild\nci\nchore\nrevert\n",
};

function judgeStep(workflowPath: string): Step {
  const source = readFileSync(join(import.meta.dir, "../..", workflowPath), "utf8");
  const workflow = parseYaml(source) as { jobs: { "pr-title": { steps: Step[] } } };
  const judge = workflow.jobs["pr-title"].steps.find((step) =>
    step.uses?.startsWith("amannn/action-semantic-pull-request@"),
  );
  return judge ?? {};
}

function actionAccepts(inputs: Record<string, string>, title: string): boolean {
  const { headerPattern, types } = { ...PRESET, ...inputs };
  const match =
    new RegExp(PRESET.breakingHeaderPattern).exec(title) ?? new RegExp(headerPattern).exec(title);
  const type = match?.[1] || null;
  const description = match?.[3] || null;
  if (type === null || description === null) return false;
  const typeListed = types
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .some((entry) => new RegExp(`^${entry}$`).test(type));
  if (!typeListed) return false;
  const subjectPattern = inputs.subjectPattern;
  if (subjectPattern === undefined) return true;
  const whole = description.match(new RegExp(subjectPattern));
  return whole !== null && whole[0].length === description.length;
}

function commitGateAccepts(title: string): boolean {
  return refusal(subject(title)) === undefined;
}

describe.each([
  ["files/pr-title/.github/workflows/pr-title.yml"],
  [".github/workflows/pr-title.yml"],
])("%s holds the title to the commit-names grammar", (workflowPath) => {
  const judge = judgeStep(workflowPath);
  const inputs = judge.with ?? {};

  test("the judge is the action the model above was traced against", () => {
    expect(judge.uses).toBe(MODELED_ACTION);
  });

  test("the judge's inputs are the shared grammar, verbatim", () => {
    expect(inputs).toEqual({
      types: `${allowedTypes.join("\n")}\n`,
      headerPattern: `^(\\w*)(?:\\((${scopeCharacterClass}+)\\))?!?: (.*)$`,
      subjectPattern: "^\\s*\\S.*$",
    });
  });

  test.each([
    ["fix(a): x", true],
    ["feat!: x", true],
    ["feat(a)!: x", true],
    ["docs: x", true],
    ["docs(all-green/build.v2_1): x", true],
    ["fix: x ", true],
    ["fix:  x", true],
    ["fix(a,b): x", false],
    ["fix(a, b): x", false],
    ["fix(a b): x", false],
    ["fix(): x", false],
    ["fix(a):x", false],
    ["fix(a): ", false],
    ["fix:  ", false],
    ["fix: \t", false],
    ["Fix(a): x", false],
    ["bogus(a): x", false],
    ["(a): x", false],
  ])("%p -> title check %p, and the commit gate agrees", (title, accepted) => {
    expect([actionAccepts(inputs, title), commitGateAccepts(title)]).toEqual([accepted, accepted]);
  });

  // The open gap: a `!` title is parsed by the preset's breakingHeaderPattern, whose scope group is `(.*)`, and the
  // action reads no input that replaces it; `scopes` and `disallowScopes` judge each comma-split piece, so neither
  // sees the comma. Recorded here so re-tracing the model at a new pin moves the rows it closes into the table above.
  test.each([["fix(a,b)!: x"], ["fix()!: x"], ["fix(a b)!: x"]])(
    "%p passes the title check and the commit gate refuses it",
    (title) => {
      expect([actionAccepts(inputs, title), commitGateAccepts(title)]).toEqual([true, false]);
    },
  );
});
