// The fleet squash-merges with the PR title as the subject, and the subject then meets actions/validate-commit-names;
// a title the pr-title check passes but that gate refuses (`fix(sync,writer): ...`, two scopes) lands red on main.
// The judge below models action-semantic-pull-request exactly: header pattern, then type in the list, then a subject;
// each input unset falls back to what the action defaults to, so the model judges as the live action would.
//   headerPattern unset -> conventional-changelog-conventionalcommits' pattern, whose scope group takes `a,b`
//   types unset         -> conventional-commit-types' list
// The root twin is judged too: nothing else pins it to the managed source.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  allowedTypes,
  conventionalSubject,
  scopeCharacterClass,
} from "../../actions/validate-commit-names/subject.ts";

interface Step {
  uses?: string;
  with?: Record<string, string>;
}

const ACTION_DEFAULTS = {
  headerPattern: "^(\\w*)(?:\\((.*)\\))?!?: (.*)$",
  types: "feat\nfix\ndocs\nstyle\nrefactor\nperf\ntest\nbuild\nci\nchore\nrevert\n",
};

function judgeInputs(workflowPath: string): Record<string, string> {
  const source = readFileSync(join(import.meta.dir, "../..", workflowPath), "utf8");
  const workflow = parseYaml(source) as { jobs: { "pr-title": { steps: Step[] } } };
  const judge = workflow.jobs["pr-title"].steps.find((step) =>
    step.uses?.startsWith("amannn/action-semantic-pull-request@"),
  );
  return judge?.with ?? {};
}

function actionAccepts(inputs: Record<string, string>, title: string): boolean {
  const { headerPattern, types } = { ...ACTION_DEFAULTS, ...inputs };
  const match = new RegExp(headerPattern).exec(title);
  if (match === null) return false;
  const [, type, , subject] = match;
  const typeListed = types
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .some((entry) => new RegExp(`^${entry}$`).test(type));
  return typeListed && subject !== "";
}

describe.each([
  ["files/pr-title/.github/workflows/pr-title.yml"],
  [".github/workflows/pr-title.yml"],
])("%s holds the title to the commit-names grammar", (workflowPath) => {
  const inputs = judgeInputs(workflowPath);

  test("the judge's inputs are the shared grammar, verbatim", () => {
    expect(inputs).toEqual({
      types: `${allowedTypes.join("\n")}\n`,
      headerPattern: `^(\\w*)(?:\\((${scopeCharacterClass}+)\\))?!?: (.*)$`,
    });
  });

  test.each([
    ["fix(a): x", true],
    ["feat!: x", true],
    ["feat(a)!: x", true],
    ["docs: x", true],
    ["docs(all-green/build.v2_1): x", true],
    ["fix(a,b): x", false],
    ["fix(a, b): x", false],
    ["fix(a b): x", false],
    ["fix(): x", false],
    ["fix(a):x", false],
    ["fix(a): ", false],
    ["Fix(a): x", false],
    ["bogus(a): x", false],
    ["(a): x", false],
  ])("%p -> title check %p, and the commit gate agrees", (title, accepted) => {
    expect([actionAccepts(inputs, title), conventionalSubject.test(title)]).toEqual([
      accepted,
      accepted,
    ]);
  });
});
