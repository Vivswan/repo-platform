// Both refresh workflows push their PR with the fleet PAT through peter-evans/create-pull-request: GitHub starts no CI for a
// push made with the run token, so a careless swap to github.token leaves every refresh PR sitting unjudged, nothing red.
// The commit identity is SYNC_IDENTITY: .github/scripts/shared/git_identity.ts names this test as its holder, and a drifted
// identity is a different author on every automation commit.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SYNC_IDENTITY } from "../../.github/scripts/shared/git_identity.ts";

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}

const ROOT = join(import.meta.dir, "../..");
const AUTOMATION_PR_ACTION = "peter-evans/create-pull-request";
const TOKEN = "${{ secrets.REPO_PLATFORM_TOKEN }}";
const SIGNATURE = `${SYNC_IDENTITY.name} <${SYNC_IDENTITY.email}>`;

test.each(["refresh-gitignore", "refresh-toolchains"])(
  "%s pushes its PR with the fleet PAT, never github.token, as the sync identity",
  (workflow) => {
    const source = readFileSync(join(ROOT, `.github/workflows/${workflow}.yml`), "utf8");
    const doc = parseYaml(source) as { jobs: Record<string, { steps: Step[] }> };
    const pr = doc.jobs.refresh.steps.filter((step) =>
      step.uses?.startsWith(`${AUTOMATION_PR_ACTION}@`),
    );
    expect(pr.map((step) => step.with)).toEqual([
      expect.objectContaining({ token: TOKEN, committer: SIGNATURE, author: SIGNATURE }),
    ]);
    expect(source).not.toContain("github.token");
  },
);
