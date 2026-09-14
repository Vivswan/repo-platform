// Both refresh workflows open their PR through peter-evans/create-pull-request and nothing else: the fixed branch is what
// lets a later run adopt the open PR instead of opening a second one, and the unconditional step (no `if:`) is what lets a
// no-diff run close a stale one. The major is pinned, not the patch: adopting, title and body refresh, and the close on
// no diff are the behaviors a major may change; Dependabot's minor and patch bumps flow.
// The fleet PAT is the only token: a github.token push would leave the PR's CI unstarted, so a missing secret fails the
// run at its first step instead of degrading to it.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SYNC_IDENTITY } from "../../.github/scripts/shared/git_identity.ts";
import { extractUsesPins } from "../shared/uses_pins.ts";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Workflow {
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
}

const ROOT = join(import.meta.dir, "../..");
const AUTOMATION_PR_ACTION = "peter-evans/create-pull-request";
const TOKEN = "${{ secrets.REPO_PLATFORM_TOKEN }}";
const SIGNATURE = `${SYNC_IDENTITY.name} <${SYNC_IDENTITY.email}>`;

interface Row {
  workflow: string;
  runs: string[];
  branch: string;
  title: string;
  body: unknown;
}

const ROWS: Row[] = [
  {
    workflow: "refresh-gitignore",
    runs: ["bun install --frozen-lockfile", "bun scripts/generate/build_gitignore.ts"],
    branch: "automation/gitignore-refresh",
    title: "chore: refresh gitignore outputs from github/gitignore",
    body:
      "Automated regeneration of the gitignore outputs (`files/base/.gitignore` and the per-module block files) " +
      "from [github/gitignore](https://github.com/github/gitignore)'s current HEAD. " +
      "The diff is the upstream change to the sections we consume. Merging this moves the stable tag once green; " +
      "the next sync pushes it to the fleet, this repository included.",
  },
  {
    workflow: "refresh-toolchains",
    runs: [
      "bun install --frozen-lockfile",
      "bun .github/scripts/refresh-toolchains/refresh_toolchains.ts",
    ],
    branch: "automation/toolchain-refresh",
    title: "fix(files): bump ${{ steps.refresh.outputs.bumps }}",
    body: "${{ steps.refresh.outputs.body }}",
  },
];

test.each(ROWS)(
  "$workflow requires the fleet token first, then opens its PR through create-pull-request alone, unconditionally, as the sync identity",
  ({ workflow, runs, branch, title, body }) => {
    const file = `.github/workflows/${workflow}.yml`;
    const source = readFileSync(join(ROOT, file), "utf8");
    const doc = parseYaml(source) as Workflow;
    const [guard, checkout, ...steps] = doc.jobs.refresh.steps;
    expect(doc.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    expect(guard).toMatchObject({ name: "Require the fleet token", env: { PAT: TOKEN } });
    expect(guard.if).toBeUndefined();
    // The guard's bash EXECUTED as the runner runs it: a missing token is the one red, a present one passes silently.
    const guarded = (pat: string) =>
      spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", String(guard.run)], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", PAT: pat },
      });
    const missing = guarded("");
    expect([missing.status, missing.stderr]).toEqual([1, ""]);
    expect(missing.stdout).toMatch(
      /^::error::the refresh cannot run: the REPO_PLATFORM_TOKEN secret is not set\. [^\n]*\n$/,
    );
    expect(guarded("ghp_present")).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(checkout).toMatchObject({
      uses: expect.stringMatching(/^actions\/checkout@/),
      with: { ref: "${{ github.event.repository.default_branch }}", token: TOKEN },
    });
    expect(steps.filter((step) => step.run !== undefined).map((step) => step.run?.trim())).toEqual(
      runs,
    );
    expect(source).not.toContain("github.token");
    expect(steps.filter((step) => step.uses?.startsWith(`${AUTOMATION_PR_ACTION}@`))).toEqual([
      {
        name: "Commit, push, and open PR",
        uses: expect.any(String),
        with: {
          token: TOKEN,
          branch,
          "delete-branch": true,
          committer: SIGNATURE,
          author: SIGNATURE,
          "commit-message": title,
          title,
          body,
        },
      },
    ]);
    expect(
      extractUsesPins(source, file).filter((pin) => pin.action === AUTOMATION_PR_ACTION),
    ).toEqual([
      {
        file,
        action: AUTOMATION_PR_ACTION,
        ref: expect.stringMatching(/^[0-9a-f]{40}$/),
        version: expect.stringMatching(/^v8\.\d+\.\d+$/),
      },
    ]);
  },
);
