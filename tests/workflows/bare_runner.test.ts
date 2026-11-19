// What would drift silently: a shipped step that leans on GitHub's image. A runner offers the baseline alone
// (docs/fleet-guidelines.md, "Runner"), GitHub's carries far more, so a step calling `gh` or `jq` with nothing fetching
// it stays green in every run the platform sees and fails only on a repository's own runner.
//   the scan      -> every shipped `run:` step: a known tool at command position needs the step that sets it up before it
//   the container -> ci.yml's bare-runner job runs every shipped action where a missing tool is a red step
// The scan reads `run:` text only: a tool a script spawns, or a third-party action calls, is the container's to catch.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_SLUG } from "../../actions/shared/platform.ts";
import { actionManifestPaths } from "../../scripts/lib/action_steps";
import { loadAction, REPO_ROOT } from "../shared/action_step";
import { shippedSource } from "../shared/shipped_source.ts";
import {
  executedWorkflowFiles,
  shippedJobs,
  WORKFLOW_FRAGMENTS,
} from "../shared/shipped_workflows.ts";

interface Step {
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, unknown>;
}

/** A step list that shares one PATH: an action's steps, a job's, or a fragment's. */
interface Scope {
  where: string;
  steps: Step[];
}

/** This repository's action at `path`, as a platform workflow (`$/`) or a starter (the delivery ref) names it. */
const platformAction = (uses: string, path: string): boolean =>
  uses === `$/${path}` || uses.startsWith(`${PLATFORM_SLUG}/${path}@`);

/** The tools a `uses:` step leaves on PATH for the steps after it. uv puts a python there only when asked to. */
function setsUp(step: Step): string[] {
  const uses = step.uses ?? "";
  if (platformAction(uses, "actions/gh-setup")) return ["gh"];
  if (uses.startsWith("oven-sh/setup-bun@")) return ["bun", "bunx"];
  if (uses.startsWith("actions/setup-node@")) return ["node", "npm", "npx"];
  if (uses.startsWith("actions-rust-lang/setup-rust-toolchain@"))
    return ["cargo", "rustc", "rustup"];
  if (uses.startsWith("astral-sh/setup-uv@")) {
    return step.with?.["activate-environment"] === true
      ? ["uv", "uvx", "python", "python3"]
      : ["uv", "uvx"];
  }
  return [];
}

/** Outside the baseline, each with the step that sets it up, or null where no shipped step may call it at all. */
const SET_UP_BY: Readonly<Record<string, string | null>> = {
  gh: "actions/gh-setup",
  bun: "oven-sh/setup-bun",
  bunx: "oven-sh/setup-bun",
  node: "actions/setup-node",
  npm: "actions/setup-node",
  npx: "actions/setup-node",
  cargo: "actions-rust-lang/setup-rust-toolchain",
  rustc: "actions-rust-lang/setup-rust-toolchain",
  rustup: "actions-rust-lang/setup-rust-toolchain",
  uv: "astral-sh/setup-uv",
  uvx: "astral-sh/setup-uv",
  python: "astral-sh/setup-uv with activate-environment",
  python3: "astral-sh/setup-uv with activate-environment",
  pip: null,
  pip3: null,
  pipx: null,
  jq: null,
  shellcheck: null,
  docker: null,
  sudo: null,
  apt: null,
  "apt-get": null,
};

/** Where bash starts a command: a line's start, an operator, a substitution, a keyword, or a command that runs its
 *  arguments (xargs after its dash options), then any `NAME=value` prefixes. */
const COMMAND_POSITION = String.raw`(?:^|[;&|({!\x60]|\$\(|\b(?:then|do|else|exec|command|env|time|xargs(?:[ \t]+-\S+)*)[ \t])[ \t]*(?:\w+=\S*[ \t]+)*`;
const COMMAND = new RegExp(
  String.raw`(?<=${COMMAND_POSITION})(?:[\w./-]*/)?([\w.+-]+)(?=[\s;|&)]|$)`,
  "gm",
);

/** The word at each command position of a `run:` body, a path cut to its last segment: comment lines dropped, a
 *  continued line joined, an expression read as one word. Quotes are not read, so a tool named after `;` or `|` inside a
 *  message counts as called. */
function commandsOf(run: string): string[] {
  const text = run
    .replace(/\$\{\{.*?\}\}/gs, "_")
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  return [...text.matchAll(COMMAND)].map((match) => match[1]);
}

/** A step's commands: its `run:` body's, and its `shell:` when that is no shell of the baseline. */
function calledBy(step: Step): string[] {
  const interpreter = (step.shell ?? "bash").split(" ")[0];
  return [
    ...commandsOf(step.run ?? ""),
    ...(["bash", "sh"].includes(interpreter) ? [] : [interpreter]),
  ];
}

/** Each call of a tool outside the baseline that no earlier step of the list set up, as `step N: tool (remedy)`. */
function leansOnTheImage(steps: Step[]): string[] {
  const onPath = new Set<string>();
  return steps.flatMap((step, index) => {
    const missing = [...new Set(calledBy(step))]
      .filter((tool) => tool in SET_UP_BY && !onPath.has(tool))
      .map((tool) => `step ${index + 1}: ${tool} (${SET_UP_BY[tool] ?? "not for a shipped step"})`);
    for (const tool of setsUp(step)) onPath.add(tool);
    return missing;
  });
}

const manifests = actionManifestPaths(join(REPO_ROOT, "actions"));
const stepsOfAction = (file: string): Step[] => loadAction(file).runs.steps;

/** Every shipped step list: each action, each job of each executed workflow, each fragment a module splices in. */
function scopes(): Scope[] {
  const jobs = executedWorkflowFiles().flatMap((rel) =>
    shippedJobs<{ steps?: Step[] }>(rel).map(([id, job]) => ({
      where: `${rel}: job '${id}'`,
      steps: job.steps ?? [],
    })),
  );
  const fragments = [...WORKFLOW_FRAGMENTS].sort().map((rel) => ({
    where: rel,
    // A fragment of comments alone parses to nothing.
    steps: (parseYaml(shippedSource(rel)) as Step[] | null) ?? [],
  }));
  return [
    ...manifests.map((file) => ({ where: file, steps: stepsOfAction(file) })),
    ...jobs,
    ...fragments,
  ];
}

describe("no shipped run step calls a tool outside the baseline that nothing before it set up", () => {
  const all = scopes();

  test("the walk reaches the actions, a called workflow's jobs, a starter's, and the fragments (ARMED)", () => {
    const reached = all.filter((scope) => scope.steps.length > 0).map((scope) => scope.where);
    expect(reached).toContain("actions/fuzz-issue/action.yml");
    expect(reached).toContain(".github/workflows/reusable-auto-assign.yml: job 'assign'");
    expect(reached).toContain("files/base/.github/workflows/ci.yml: job 'all-green'");
    expect(reached).toContain("files/rust/.github/workflows/checks.toolchain.yml");
  });

  test.each<{ planted: string; steps: Step[]; refused: string[] }>([
    { planted: "sudo apt-get", steps: [{ run: "sudo apt-get install -y jq" }], refused: ["sudo"] },
    {
      planted: "apt-get as root",
      steps: [{ run: "apt-get update && apt-get install -y x" }],
      refused: ["apt-get"],
    },
    { planted: "pip", steps: [{ run: 'pip install "yamllint==1.0"' }], refused: ["pip"] },
    {
      planted: "pipx behind a test",
      steps: [{ run: "command -v x || pipx install x" }],
      refused: ["pipx"],
    },
    { planted: "python3", steps: [{ run: "python3 -m pip --version" }], refused: ["python3"] },
    {
      planted: "python after a uv that activates nothing",
      steps: [{ uses: "astral-sh/setup-uv@0" }, { run: "python -m gate" }],
      refused: ["python"],
    },
    {
      planted: "shell: python",
      steps: [{ shell: "python", run: "print(1)" }],
      refused: ["python"],
    },
    { planted: "node", steps: [{ run: 'node "$GITHUB_ACTION_PATH/x.js"' }], refused: ["node"] },
    { planted: "npx on a later line", steps: [{ run: "cd site\nnpx knip" }], refused: ["npx"] },
    { planted: "jq in a pipe", steps: [{ run: "cat x.json | jq -r .a" }], refused: ["jq"] },
    {
      planted: "shellcheck by path",
      steps: [{ run: "/usr/bin/shellcheck x.sh" }],
      refused: ["shellcheck"],
    },
    { planted: "docker", steps: [{ run: "docker run --rm alpine true" }], refused: ["docker"] },
    { planted: "gh", steps: [{ run: 'gh api "repos/$GH_REPO"' }], refused: ["gh"] },
    {
      planted: "gh in a substitution",
      steps: [{ run: "n=$(gh issue list --json number)" }],
      refused: ["gh"],
    },
    {
      planted: "gh behind xargs",
      steps: [{ run: "cat ids | xargs -r -I{} gh issue close {}" }],
      refused: ["gh"],
    },
    {
      planted: "gh behind an assignment",
      steps: [{ run: "GH_TOKEN=$T gh pr list" }],
      refused: ["gh"],
    },
    {
      planted: "gh before its setup",
      steps: [{ run: "gh pr list" }, { uses: "$/actions/gh-setup" }],
      refused: ["gh"],
    },
    { planted: "uv", steps: [{ run: "uv run --locked yamllint ." }], refused: ["uv"] },
    { planted: "bun", steps: [{ run: "bun install --frozen-lockfile" }], refused: ["bun"] },
  ])("a planted $planted is refused (ARMED)", ({ steps, refused }) => {
    expect(leansOnTheImage(steps).map((line) => line.split(" ")[2])).toEqual(refused);
  });

  test.each<{ allowed: string; steps: Step[] }>([
    {
      allowed: "gh after gh-setup",
      steps: [{ uses: "$/actions/gh-setup" }, { run: "gh pr list" }],
    },
    {
      allowed: "gh after a starter's gh-setup",
      steps: [{ uses: `${PLATFORM_SLUG}/actions/gh-setup@stable` }, { run: "gh pr list" }],
    },
    {
      allowed: "python after a uv that activates its environment",
      steps: [
        { uses: "astral-sh/setup-uv@0", with: { "activate-environment": true } },
        { run: "python -m gate" },
      ],
    },
    { allowed: "the action's bun by path", steps: [{ run: '"$ACTION_BUN" install --production' }] },
    { allowed: "a tool as an argument", steps: [{ run: "echo gh jq python; command -v node" }] },
    {
      allowed: "a jq program handed to gh's --jq",
      steps: [{ uses: "$/actions/gh-setup" }, { run: "gh api x --jq '.[] | select(.a)'" }],
    },
    { allowed: "a comment", steps: [{ run: "# jq would be simpler\ntrue" }] },
  ])("$allowed passes", ({ steps }) => {
    expect(leansOnTheImage(steps)).toEqual([]);
  });

  test.each(all)("$where", ({ steps }) => {
    expect(leansOnTheImage(steps)).toEqual([]);
  });
});

describe("the bare container runs every shipped action", () => {
  interface Job {
    steps: Step[];
  }
  const job = (
    parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, Job>;
    }
  ).jobs["bare-runner"];

  /** The action directory a `$/actions/...` step names. */
  const named = (step: Step): string[] => {
    const dir = /^\$\/(actions\/.+)$/.exec(step.uses ?? "")?.[1];
    return dir === undefined ? [] : [dir];
  };

  test("each is a step of the job or of an action the job runs, but the two that write outside the repository", () => {
    const reached = new Set<string>();
    const queue = job.steps.flatMap(named);
    for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
      if (reached.has(dir)) continue;

      reached.add(dir);
      queue.push(...stepsOfAction(`${dir}/action.yml`).flatMap(named));
    }
    // release-assets reads a draft release by its id, and this repository cuts no releases; npm-publish publishes a
    // package to npm, and this repository has none.
    const unreachable = new Set(["actions/npm-publish", "actions/release-assets"]);
    expect([...reached].sort()).toEqual(
      manifests.map(dirname).filter((dir) => !unreachable.has(dir)),
    );
  });

  test("its gate steps are the skeleton's, but for the needs context", () => {
    const gate = (steps: Step[]) =>
      steps
        .filter((step) => /^(astral-sh\/setup-uv|re-actors\/alls-green)@/.test(step.uses ?? ""))
        .map((step) => (step.uses?.startsWith("re-actors/") ? { uses: step.uses } : step));
    const skeleton = Object.fromEntries(
      shippedJobs<{ steps?: Step[] }>("files/base/.github/workflows/ci.yml"),
    )["all-green"];
    expect(gate(job.steps.slice(-2))).toEqual(gate(skeleton.steps ?? []));
    expect(gate(job.steps)).toHaveLength(2);
  });
});
