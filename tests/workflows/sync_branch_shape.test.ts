// The facts GitHub leaves to this checkout to hold for the label-triggered branch sync (docs/sync.md, "Syncing a branch by label"):
//   `labeled` fires for every label      -> the job's own condition names the one label, and the skeleton ci.yml never
//                                           takes `labeled` (it would rerun CI and cancel the in-flight run on every label)
//   a fork's PR carries a read-only token -> the same-repository guard skips at zero minutes instead of failing at the push
//   the nightly apply deletes undeclared labels -> the label the condition reads must be one the baseline layer declares
//   the repository token is the only credential -> no `secrets.` anywhere, and the grants are the push and the comment

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_OWNER, SYNC_LABEL } from "../../actions/shared/platform.ts";

const ROOT = join(import.meta.dir, "../..");
const SKELETONS = "files/base/.github/workflows";

interface Workflow {
  on: { pull_request?: { types?: string[] } };
  permissions?: Record<string, string>;
  jobs: Record<string, { if?: string; permissions?: Record<string, string> }>;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const load = (rel: string) =>
  parseYaml(read(rel).replaceAll("{{github_username}}", PLATFORM_OWNER)) as Workflow;

test("the labeled event runs one job, for the platform's label on a same-repository branch, with the repository token alone", () => {
  const text = read(`${SKELETONS}/sync-branch.yml`);
  const workflow = load(`${SKELETONS}/sync-branch.yml`);
  const skeleton = load(`${SKELETONS}/ci.yml`);
  const baseline = parseYaml(read("files/settings/baseline.yml")) as {
    labels: { name: string }[];
  };
  const jobs = Object.values(workflow.jobs);
  expect({
    trigger: workflow.on,
    jobs: jobs.length,
    condition: jobs[0]?.if?.replaceAll(/\s+/g, " ").trim(),
    workflowPermissions: workflow.permissions,
    jobPermissions: jobs[0]?.permissions,
    secrets: text.match(/secrets\.\w+/g) ?? [],
    skeletonPullRequestTypes: skeleton.on.pull_request?.types,
    declaredLabels: baseline.labels.filter((label) => label.name === SYNC_LABEL).length,
  }).toEqual({
    trigger: { pull_request: { types: ["labeled"] } },
    jobs: 1,
    condition: `github.event.label.name == '${SYNC_LABEL}' && github.event.pull_request.head.repo.full_name == github.repository`,
    workflowPermissions: {},
    jobPermissions: { contents: "write", "pull-requests": "write" },
    secrets: [],
    skeletonPullRequestTypes: undefined,
    declaredLabels: 1,
  });
});
