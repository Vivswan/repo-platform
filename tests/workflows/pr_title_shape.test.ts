// The fleet squash-merges with the PR title as the subject, and the subject then meets actions/validate-commit-names;
// a title the pr-title check passes but that gate refuses (`fix(sync,writer): ...`, two scopes) lands red on main.
// The commit side of every row is the gate itself: the action run in title mode, commitlint over its config.
// The title side models MODELED_ACTION's src/validatePrTitle.js on its bundled parser (conventional-commits-parser 6,
// conventional-changelog-conventionalcommits 9.1.0 parser options); a pin bump reds the uses pin below until re-traced:
//   parseHeader             -> the preset's breakingHeaderPattern is tried first; no action input replaces it
//   matched group `|| null` -> a whitespace-only description IS a subject, only "" is refused
//   types (parseEnum)       -> split on newline, trimmed, empties dropped, each wrapped in ^ $
//   subjectPattern          -> must match the WHOLE subject (match[0].length === subject.length)
// Titles are single-line, so multi-line inputs are not rows: both sides refuse "fix: x\ry" (`.` stops at \r in
// either header pattern).
// The root twin is judged too: nothing else pins it to the managed source.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../shared/bounded_spawn.ts";

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

const ACTION = join(
  import.meta.dir,
  "../..",
  "actions/validate-commit-names/validate-commit-names.ts",
);
const gateVerdicts = new Map<string, boolean>();

function commitGateAccepts(title: string): boolean {
  let accepted = gateVerdicts.get(title);
  if (accepted === undefined) {
    accepted =
      boundedSpawnSync([process.execPath, ACTION], {
        env: { PATH: process.env.PATH, PR_TITLE: title },
      }).exitCode === 0;
    gateVerdicts.set(title, accepted);
  }
  return accepted;
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

  test("the judge's inputs are the gate's type list and scope class, verbatim", () => {
    expect(inputs).toEqual({
      types: "build\nchore\nci\ndocs\nfeat\nfix\nperf\nrefactor\nrevert\nstyle\ntest\n",
      headerPattern: "^(\\w*)(?:\\(([A-Za-z0-9._/-]+)\\))?!?: (.*)$",
      subjectPattern: "^\\s*\\S.*$",
    });
  });

  test.each([
    ["fix(a): x", true],
    ["feat!: x", true],
    ["feat(a)!: x", true],
    ["docs: x", true],
    ["docs(all-green/build.v2_1): x", true],
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

  // The open gaps, closed only by running the gate itself on the title: a `!` title is parsed by the preset's
  // breakingHeaderPattern, whose scope group is `(.*)`, and the action reads no input that replaces it; and the
  // action has no case, full-stop, or trim rule where config-conventional refuses.
  test.each([
    ["fix(a,b)!: x"],
    ["fix()!: x"],
    ["fix(a b)!: x"],
    ["fix: Repair installer"],
    ["fix: x."],
    ["fix: x "],
  ])("%p passes the title check and the commit gate refuses it", (title) => {
    expect([actionAccepts(inputs, title), commitGateAccepts(title)]).toEqual([true, false]);
  });
});
