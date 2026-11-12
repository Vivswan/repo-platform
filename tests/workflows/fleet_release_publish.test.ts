// This repository cuts no releases, so no run here reaches the publish job before the fleet's first release does.
//
// The release leg past the cut is replayed instead, from what the cut step wrote: fleet-release.yml's outputs, the
// caller's `with:`, the publish job's steps under the runner's bash, and release-assets' own script, against a fake
// repository.
//
// The tag the draft wears reaches a step only as the fake's answer to the lookup by id. So a step that names the
// cut's tag, or an id lost on the way, publishes nothing here.

import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAction, REPO_ROOT, runBashStep } from "../shared/action_step";
import { argvStub } from "../shared/argv_stub";
import { evaluateCondition, interpolate } from "../shared/github_expression";
import { tempDirs } from "../shared/temp_dir";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Job {
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  with?: Record<string, string>;
  steps?: Step[];
}
interface CalledWorkflow {
  on: {
    workflow_call: {
      inputs?: Record<string, { required?: boolean; default?: string }>;
      outputs?: Record<string, { value: string }>;
    };
  };
  jobs: Record<string, Job>;
}

/** An expression context, each key a dotted path. */
type Context = Record<string, string | boolean>;

/** A step's outputs, or null when it failed. */
type Outputs = Record<string, string> | null;

// The skeleton's `uses:` lines carry the owner placeholder, which YAML reads as a flow mapping, so it is filled before
// parsing.
//
// The fake repository holds two releases. One is the draft, id 4242, wearing `v1.2.3`, with one asset and a bundle a
// prior attempt left. The other is the latest published release, id 4100, wearing `v1.2.2`: what gh answers when the
// tag it is given is empty. Every other tag names no release, as the cut's tag does once a hook renamed the draft.
//
// CUT is what release-please-action writes for the draft it created; each case adds the tag it gave the draft.

const temp = tempDirs();

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");
const cutWorkflow = parseYaml(read(".github/workflows/fleet-release.yml")) as CalledWorkflow;
const cutJob = cutWorkflow.jobs["release-please"];
const publishWorkflow = parseYaml(
  read(".github/workflows/fleet-release-publish.yml"),
) as CalledWorkflow;
const publishJob = publishWorkflow.jobs["publish-release"];
const skeleton = parseYaml(
  read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
) as { jobs: Record<string, Job> };

const REPO = "o/r";
const DRAFT = JSON.stringify({
  tag_name: "v1.2.3",
  draft: true,
  assets: [{ name: "app.tar.gz" }, { name: "attestation.json" }],
});
const LATEST_PUBLISHED = JSON.stringify({
  tag_name: "v1.2.2",
  draft: false,
  assets: [{ name: "app.tar.gz" }],
});
const FAKE_GH = [
  'case "$*" in',
  `  "api repos/${REPO}/releases/4242") echo '${DRAFT}' ;;`,
  `  "api repos/${REPO}/releases/4100") echo '${LATEST_PUBLISHED}' ;;`,
  '  "release view v1.2.3 --json databaseId --jq "*) echo "id=4242" ;;',
  '  "release view  --json databaseId --jq "*) echo "id=4100" ;;',
  '  "release "*" v1.2.3 "* | "release "*" v1.2.2 "*) ;;',
  '  *) echo "release not found" >&2; exit 1 ;;',
  "esac",
];

const gh = (...args: string[]) => ["gh", ...args];
const FOUND_BY_ID = gh("api", `repos/${REPO}/releases/4242`);
const PUBLISHED = [
  gh("release", "delete-asset", "v1.2.3", "attestation.json", "--yes", "--repo", REPO),
  gh("release", "download", "v1.2.3", "--dir", "assets"),
  gh("release", "upload", "v1.2.3", "attestation.json", "--clobber"),
  gh("release", "edit", "v1.2.3", "--draft=false"),
];

const CUT = { release_created: "true", id: "4242" };
const SKELETON_SENDS = skeleton.jobs["publish-release"].with ?? {};

function under(path: string, values: Record<string, string>): Context {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [`${path}.${key}`, value]),
  );
}

function filled(
  values: Record<string, string> | undefined,
  context: Context,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [key, interpolate(value, context)]),
  );
}

function valuesOf(outputs: Record<string, { value: string }> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(outputs ?? {}).map(([name, { value }]) => [name, value]),
  );
}

/** What a caller reads as `needs.release.outputs` once the cut step wrote `cut`: fleet-release.yml's job outputs,
 *  then its workflow_call outputs. */
function releaseOutputs(cut: Record<string, string>): Context {
  const jobOutputs = filled(cutJob.outputs, under("steps.cut.outputs", cut));
  const called = under("jobs.release-please.outputs", jobOutputs);
  return under(
    "needs.release.outputs",
    filled(valuesOf(cutWorkflow.on.workflow_call.outputs), called),
  );
}

/** The inputs the called job reads, or why GitHub refuses the call when the run is created: an input the called
 *  workflow does not declare, or a required one the caller omits. */
function inputsOf(sent: Record<string, string>, needs: Context): Context | string {
  const declared = publishWorkflow.on.workflow_call.inputs ?? {};
  const undeclared = Object.keys(sent).filter((name) => !Object.hasOwn(declared, name));
  const omitted = Object.keys(declared).filter(
    (name) => declared[name].required === true && !Object.hasOwn(sent, name),
  );
  if (undeclared.length + omitted.length > 0) {
    return `the call is refused: undeclared [${undeclared}], omitted [${omitted}]`;
  }

  const defaults = Object.fromEntries(
    Object.entries(declared).map(([name, spec]) => [name, spec.default ?? ""]),
  );
  return under("inputs", { ...defaults, ...filled(sent, needs) });
}

/** A `run:` step under the runner's bash, its expressions filled over `context`. */
function shell(
  step: Step,
  context: Context,
  inherited: Record<string, string>,
  root: string,
): Outputs {
  const ran = runBashStep(
    {
      ...step,
      env: { ...inherited, ...filled(step.env, context) },
      run: interpolate(String(step.run), context),
    },
    { cwd: root, root },
  );
  return ran.exitCode === 0 ? ran.outputs : null;
}

/** A platform action's outputs, from its own steps that write them; the bun setup and the install are the runner's. */
function platformAction(
  name: string,
  sent: Record<string, string>,
  inherited: Record<string, string>,
  root: string,
): Outputs {
  const action = loadAction(`actions/${name}/action.yml`);
  const wired = valuesOf(action.outputs);
  const inner: Context = {
    ...under("inputs", sent),
    "steps.action-bun.outputs.path": process.execPath,
    "github.action_path": join(REPO_ROOT, "actions", name),
  };
  for (const step of action.runs.steps as Step[]) {
    const writes = Object.values(wired).some((value) =>
      value.includes(`steps.${step.id}.outputs.`),
    );
    if (step.run === undefined || !writes) continue;

    const outputs = shell(step, inner, inherited, root);
    if (outputs === null) return null;

    Object.assign(inner, under(`steps.${step.id}.outputs`, outputs));
  }

  return filled(wired, inner);
}

/** A third-party action is not run: it counts as succeeded, writing what its own documentation says it writes. */
function thirdParty(uses: string, root: string): Outputs {
  if (!uses.startsWith("actions/attest-build-provenance@")) {
    throw new Error(`no stand-in for ${uses}`);
  }

  writeFileSync(join(root, "bundle.json"), "{}");
  return { "bundle-path": join(root, "bundle.json") };
}

function stepOutputs(
  step: Step,
  context: Context,
  jobEnv: Record<string, string>,
  root: string,
): Outputs {
  if (step.run !== undefined) return shell(step, context, jobEnv, root);

  const platform = /^\$\/actions\/([\w-]+)$/.exec(step.uses ?? "")?.[1];
  if (platform === undefined) return thirdParty(String(step.uses), root);

  const stepEnv = { ...jobEnv, ...filled(step.env, context) };
  return platformAction(platform, filled(step.with, context), stepEnv, root);
}

/** The publish job as the runner runs it for a public repository, from what the cut step wrote and what the caller
 *  sends: the step that turned it red (or the refused call), and every `gh` call it made. */
function publish(
  cut: Record<string, string>,
  sent: Record<string, string>,
): { red: string | null; calls: string[][] } {
  const inputs = inputsOf(sent, releaseOutputs(cut));
  if (typeof inputs === "string") return { red: inputs, calls: [] };

  const root = temp.dir("publish-release-");
  const fake = argvStub(root, "gh", FAKE_GH);
  const context: Context = {
    ...inputs,
    "github.repository": REPO,
    "github.token": "token",
    "github.event.repository.visibility": "public",
  };
  const declaredEnv = filled(publishJob.env, context);
  Object.assign(context, under("env", declaredEnv));
  const jobEnv = {
    ...declaredEnv,
    PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
    GITHUB_REPOSITORY: REPO,
  };

  for (const step of publishJob.steps ?? []) {
    const id = String(step.id ?? step.name ?? step.uses);
    const runs = step.if === undefined || evaluateCondition(step.if, context);
    const outputs = runs ? stepOutputs(step, context, jobEnv, root) : {};
    if (outputs === null) return { red: id, calls: fake.calls() };

    context[`steps.${id}.outcome`] = runs ? "success" : "skipped";
    Object.assign(context, under(`steps.${id}.outputs`, outputs));
  }

  return { red: null, calls: fake.calls() };
}

test.each<{
  reason: string;
  cut: Record<string, string>;
  sent: Record<string, string>;
  calls: string[][];
}>([
  {
    reason:
      "the update-release hook renamed the draft, so the tag the cut reported names no release",
    cut: { ...CUT, tag_name: "source-v1.2.3" },
    sent: SKELETON_SENDS,
    calls: [FOUND_BY_ID, ...PUBLISHED],
  },
  {
    reason: "the hook left the draft under the cut's tag",
    cut: { ...CUT, tag_name: "v1.2.3" },
    sent: SKELETON_SENDS,
    calls: [FOUND_BY_ID, ...PUBLISHED],
  },
  {
    reason: "a ci.yml the sync has not replaced sends the cut's tag and no id",
    cut: { ...CUT, tag_name: "v1.2.3" },
    sent: { tag: "${{ needs.release.outputs.tag_name }}" },
    calls: [
      gh("release", "view", "v1.2.3", "--json", "databaseId", "--jq", '"id=\\(.databaseId)"'),
      FOUND_BY_ID,
      ...PUBLISHED,
    ],
  },
])(
  "the draft the cut created is published under the tag it wears by then: $reason",
  ({ cut, sent, calls }) => {
    expect(publish(cut, sent)).toEqual({ red: null, calls });
  },
);

// The cut reports a release and no id, and the skeleton sends no tag. Asked for an empty tag, gh answers the latest
// published release, so the job would attest and publish that one, green, with the cut's draft still a draft.
test("a publish job sent neither an id nor a tag is red at its first step, before any gh call", () => {
  const cut = { release_created: "true", tag_name: "v1.2.3" };

  expect(publish(cut, SKELETON_SENDS)).toEqual({ red: "by-tag", calls: [] });
});
