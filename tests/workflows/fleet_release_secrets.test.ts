// A caller that passes a secret the called workflow does not declare fails at run creation, so the build branch's
// release workflows must keep every secret the fleet's ci.yml passes them: the copy already deployed in the fleet
// as well as the skeleton the next sync writes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface CalledWorkflow {
  on: { workflow_call?: { secrets?: Record<string, { required?: boolean }> } | null };
}
interface CallerJob {
  uses?: string;
  secrets?: Record<string, string> | "inherit";
}

const root = join(import.meta.dir, "../..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const declaredSecrets = (rel: string): Record<string, { required?: boolean }> =>
  (parseYaml(read(rel)) as CalledWorkflow).on.workflow_call?.secrets ?? {};

const skeleton = parseYaml(
  read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
) as {
  jobs: Record<string, CallerJob>;
};
const platformCall = /^owner\/repo-platform\/(\.github\/workflows\/[^@]+)@build$/;

describe("the release workflows' secrets", () => {
  test("every secret the skeleton passes to a platform workflow is one it declares", () => {
    const calls = Object.entries(skeleton.jobs).filter(([, job]) =>
      platformCall.test(job.uses ?? ""),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const [jobId, job] of calls) {
      const rel = (job.uses ?? "").match(platformCall)?.[1] ?? "";
      const passed = typeof job.secrets === "object" ? Object.keys(job.secrets) : [];
      const declared = Object.keys(declaredSecrets(rel));
      for (const name of passed) expect(declared, `${jobId} -> ${rel}`).toContain(name);
    }
  });

  // The fleet's deployed ci.yml passes REPO_PLATFORM_TOKEN until its next sync PR merges; the declaration leaves
  // in the round after that one, never in the same round as the skeleton's passthrough.
  test.each([".github/workflows/fleet-release.yml", ".github/workflows/fleet-release-publish.yml"])(
    "%s still declares the fleet token the deployed ci.yml passes, optional",
    (rel) => {
      expect(declaredSecrets(rel).REPO_PLATFORM_TOKEN).toEqual(
        expect.objectContaining({ required: false }),
      );
    },
  );
});
