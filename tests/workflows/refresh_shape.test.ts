// The refresh workflow pushes its PR with the fleet PAT through peter-evans/create-pull-request: GitHub starts no CI for a
// push made with the run token, so a careless swap to github.token leaves every refresh PR sitting unjudged, nothing red.
// The commit identity is SYNC_IDENTITY: .github/scripts/shared/git_identity.ts names this test as its holder, and a drifted
// identity is a different author on every automation commit.
// The job's bun install runs husky's prepare, which points the checkout's hooks at the developer pre-commit hook; a
// dropped HUSKY=0 shows up a week later, when the next schedule's commit fails the hook on a runner without uv.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SYNC_IDENTITY } from "../../.github/scripts/shared/git_identity.ts";

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  env?: Record<string, unknown>;
  steps: Step[];
}

const ROOT = join(import.meta.dir, "../..");
const AUTOMATION_PR_ACTION = "peter-evans/create-pull-request";
const TOKEN = "${{ secrets.REPO_PLATFORM_TOKEN }}";
const SIGNATURE = `${SYNC_IDENTITY.name} <${SYNC_IDENTITY.email}>`;

const source = readFileSync(join(ROOT, ".github/workflows/refresh-upstream.yml"), "utf8");
const refresh = (parseYaml(source) as { jobs: { refresh: Job } }).jobs.refresh;

test("refresh-upstream pushes its PR with the fleet PAT, never github.token, as the sync identity", () => {
  const pr = refresh.steps.filter((step) => step.uses?.startsWith(`${AUTOMATION_PR_ACTION}@`));
  expect(pr.map((step) => step.with)).toEqual([
    expect.objectContaining({ token: TOKEN, committer: SIGNATURE, author: SIGNATURE }),
  ]);
  expect(source).not.toContain("github.token");
});

test("refresh-upstream commits under HUSKY=0: the developer pre-commit hook never judges the pin bump on the runner", () => {
  expect(refresh.env).toEqual(expect.objectContaining({ HUSKY: "0" }));
});
