// GitHub resolves the references inside a composite action and a caller's `with:` block at run time and refuses none of
// them: an unknown `steps.<id>` or `inputs.<x>` reads as an empty string, an unknown `with:` key is a log warning. actionlint
// refuses action.yml outright ("jobs section is missing"), zizmor reads no references, and tests/workflows judges workflows
// only, so a typo in any of the three is green everywhere but here: a retry `if` that never fires, an output map that hands
// the caller nothing, a renamed input every caller keeps passing under the old name.

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_OWNER, PLATFORM_SLUG } from "../../actions/shared/platform.ts";
import { type Action, REPO_ROOT, type Step } from "../shared/action_step";

const ACTIONS_DIR = join(REPO_ROOT, "actions");
const ACTION_NAMES = readdirSync(ACTIONS_DIR)
  .filter((name) => existsSync(join(ACTIONS_DIR, name, "action.yml")))
  .sort();
const CALLER_ROOTS = [
  ".github/workflows",
  ...readdirSync(join(REPO_ROOT, "files")).map((module) => `files/${module}/.github/workflows`),
].filter((root) => existsSync(join(REPO_ROOT, root)));

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const STEP_REF = /\bsteps\.([\w-]+)\.(?:outputs\.([\w-]+)|outcome|conclusion)\b/g;
const INPUT_REF = /\binputs\.([\w-]+)/g;
const ACTION_PATH = "${{ github.action_path }}";
const SCRIPT_TOKEN = /\S+\.ts\b/g;
const OWN_ACTION = new RegExp(`^(?:\\./actions/|${PLATFORM_SLUG}/actions/)([\\w-]+)(?:@|$)`);

interface Caller {
  uses: string;
  with?: Record<string, unknown>;
}

function loadYaml(rel: string): unknown {
  const text = readFileSync(join(REPO_ROOT, rel), "utf8")
    .replace(/^\{\{blocks\}\}$/gm, "")
    .replaceAll("{{github_username}}", PLATFORM_OWNER)
    .replace(/\{\{(\w+)\}\}/g, "$1");
  return parseYaml(text);
}

const loadAction = (name: string): Action => loadYaml(`actions/${name}/action.yml`) as Action;

/** An `if:` is an expression whole; everywhere else only the `${{ }}` spans are. */
function expressionsOf(node: unknown): string[] {
  const found = [...JSON.stringify(node).matchAll(EXPRESSION)].map((m) => m[1]);
  const condition = (node as { if?: unknown }).if;
  if (typeof condition === "string") found.push(condition);
  return found;
}

/** In a run, a key leaves through `echo "key=..." >> "$GITHUB_OUTPUT"` (the write on the same line); a shell assignment
 *  `key=$(...)` is not a write. In a script it leaves as a template or string line `key=`, the name handed to the
 *  writer (`setOutput("key"`), a quoted record key (`"key":` opening an entry), or the only key of a returned record
 *  (`return { key: x }`). The text is read, not run: a reference to a name some other single-key record returns
 *  passes here and is caught by the step's own test. */
function writesKey(text: string, key: string, form: "run" | "script"): boolean {
  const name = key.replaceAll("-", "\\-");
  if (form === "run") return new RegExp(`(["']|echo\\s+)${name}=[^\\n]*GITHUB_OUTPUT`).test(text);
  const lines = text.replaceAll("\\n", "\n");
  return (
    new RegExp(`(^|["'\`])${name}=`, "m").test(lines) ||
    new RegExp(`setOutput\\(\\s*["'\`]${name}["'\`]`).test(lines) ||
    new RegExp(`(^|[{,])\\s*["'\`]${name}["'\`]\\s*:`, "m").test(lines) ||
    new RegExp(`return\\s*\\{\\s*${name}:[^{},]*\\}`).test(lines)
  );
}

function scriptsOf(actionName: string, step: Step): { run: string; scripts: string[] } {
  const actionDir = join(ACTIONS_DIR, actionName);
  const run = String(step.run).replaceAll(ACTION_PATH, actionDir);
  const scripts = [...run.matchAll(SCRIPT_TOKEN)]
    .map((m) => m[0].replace(/^["']|["']$/g, ""))
    .filter((token) => resolve(token).startsWith(`${actionDir}/`))
    .map((path) => readFileSync(path, "utf8"));
  return { run, scripts };
}

/** A third-party action's outputs cannot be read offline; only the step id is judged for one. */
function stepWrites(actionName: string, step: Step, key: string): boolean {
  if (typeof step.run === "string") {
    const { run, scripts } = scriptsOf(actionName, step);
    return writesKey(run, key, "run") || scripts.some((script) => writesKey(script, key, "script"));
  }
  const own = OWN_ACTION.exec(String(step.uses));
  if (own === null) return true;
  return Object.hasOwn(loadAction(own[1]).outputs ?? {}, key);
}

function manifestProblems(name: string, action: Action): string[] {
  const inputs = new Set(Object.keys(action.inputs ?? {}));
  const steps = action.runs.steps;
  const byId = new Map(steps.filter((s) => typeof s.id === "string").map((s) => [String(s.id), s]));
  const problems: string[] = [];
  const judge = (where: string, expressions: string[], visible: Set<string>) => {
    for (const expression of expressions) {
      for (const m of expression.matchAll(INPUT_REF)) {
        if (!inputs.has(m[1])) problems.push(`${where}: inputs.${m[1]} is not declared`);
      }
      for (const [, id, key] of expression.matchAll(STEP_REF)) {
        const step = byId.get(id);
        if (!visible.has(id) || step === undefined) {
          problems.push(`${where}: steps.${id} is no earlier step`);
        } else if (key !== undefined && !stepWrites(name, step, key)) {
          problems.push(`${where}: steps.${id} writes no output '${key}'`);
        }
      }
    }
  };
  const earlier = new Set<string>();
  steps.forEach((step, index) => {
    judge(`step ${index + 1} (${String(step.name ?? step.id)})`, expressionsOf(step), earlier);
    if (typeof step.id === "string") earlier.add(step.id);
  });
  for (const [output, spec] of Object.entries(action.outputs ?? {})) {
    judge(`outputs.${output}`, expressionsOf(spec), new Set(byId.keys()));
  }
  return problems;
}

/** A starter block's fragment is an indented sequence with no `jobs:` above it, so the walk takes every array. */
function callSites(node: unknown, path: string): [string, Caller][] {
  if (Array.isArray(node)) return node.flatMap((item, i) => callSites(item, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const own: [string, Caller][] =
    typeof record.uses === "string" && OWN_ACTION.test(record.uses)
      ? [[`${path} ${record.uses}`, record as unknown as Caller]]
      : [];
  return own.concat(
    Object.entries(record).flatMap(([key, value]) => callSites(value, `${path}.${key}`)),
  );
}

function callerProblems(caller: Caller, actions: Map<string, Action>): string[] {
  const name = OWN_ACTION.exec(caller.uses)?.[1] ?? "";
  const action = actions.get(name);
  if (action === undefined) return [`no action '${name}'`];
  const declared = action.inputs ?? {};
  const passed = Object.keys(caller.with ?? {});
  const problems = passed
    .filter((key) => !Object.hasOwn(declared, key))
    .map((key) => `passes '${key}', which ${name} does not declare`);
  for (const [key, spec] of Object.entries(declared)) {
    if (spec.required === true && spec.default === undefined && !passed.includes(key)) {
      problems.push(`omits '${key}', which ${name} requires`);
    }
  }
  return problems;
}

const CONTROL_ACTION: Action = {
  name: "control",
  inputs: { mode: { description: "", required: true } },
  outputs: { path: { description: "", value: "${{ steps.gone.outputs.path }}" } },
  runs: {
    using: "composite",
    steps: [
      {
        id: "first",
        if: "inputs.mod == 'x'",
        shell: "bash",
        run: 'echo "path=1" >> "$GITHUB_OUTPUT"',
      },
      { id: "second", shell: "bash", run: "true", env: { A: "${{ steps.first.outputs.pat }}" } },
      { id: "third", shell: "bash", run: "true", if: "steps.fourth.outcome == 'failure'" },
    ],
  },
};

test("every steps.<id>, inputs.<x>, and output mapping in the action manifests names a step, an input, and a key the step writes", () => {
  const actions = new Map(ACTION_NAMES.map((name) => [name, loadAction(name)]));
  const judged = Object.fromEntries(
    [...actions].map(([name, action]) => [name, manifestProblems(name, action)]),
  );
  expect(judged).toEqual(Object.fromEntries(ACTION_NAMES.map((name) => [name, []])));
  expect(manifestProblems("control", CONTROL_ACTION)).toEqual([
    "step 1 (first): inputs.mod is not declared",
    "step 2 (second): steps.first writes no output 'pat'",
    "step 3 (third): steps.fourth is no earlier step",
    "outputs.path: steps.gone is no earlier step",
  ]);
});

test("every with: key a workflow, a starter, or a composite passes to a platform action is declared, and every required input is passed", () => {
  const actions = new Map(ACTION_NAMES.map((name) => [name, loadAction(name)]));
  const documents = [
    ...CALLER_ROOTS.flatMap((root) =>
      readdirSync(join(REPO_ROOT, root))
        .filter((file) => file.endsWith(".yml"))
        .map((file) => `${root}/${file}`),
    ),
    ...ACTION_NAMES.map((name) => `actions/${name}/action.yml`),
  ];
  const sites = documents.flatMap((rel) => callSites(loadYaml(rel), rel));
  const judged = Object.fromEntries(
    sites.map(([site, caller]) => [site, callerProblems(caller, actions)]),
  );
  expect(judged).toEqual(Object.fromEntries(sites.map(([site]) => [site, []])));
  // A knob with one value across every caller is a constant: an input no caller passes, or an action no caller
  // names, is dead surface the diff alone would let in.
  const passed = new Map(ACTION_NAMES.map((name) => [name, new Set<string>()]));
  for (const [, caller] of sites) {
    const name = OWN_ACTION.exec(caller.uses)?.[1] ?? "";
    for (const key of Object.keys(caller.with ?? {})) passed.get(name)?.add(key);
  }
  const unpassed = Object.fromEntries(
    [...actions].map(([name, action]) => [
      name,
      Object.keys(action.inputs ?? {}).filter((key) => !passed.get(name)?.has(key)),
    ]),
  );
  expect(unpassed).toEqual(Object.fromEntries(ACTION_NAMES.map((name) => [name, []])));
  const called = new Set(sites.map(([, caller]) => OWN_ACTION.exec(caller.uses)?.[1]));
  expect([...called].sort()).toEqual(ACTION_NAMES);
  const control = {
    uses: `${PLATFORM_SLUG}/actions/fuzz-issue@stable`,
    with: { mode: "report", labels: "x" },
  };
  expect(callerProblems(control, actions)).toEqual([
    "passes 'labels', which fuzz-issue does not declare",
    "omits 'label', which fuzz-issue requires",
    "omits 'stream', which fuzz-issue requires",
  ]);
});
