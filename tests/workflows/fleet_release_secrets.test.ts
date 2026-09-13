// A caller that passes a secret the called workflow does not declare fails at run creation, so the delivery ref's
// workflows must declare every secret the skeleton passes them. The release legs are passed none: their two
// workflows declare no secrets and run on github.token alone.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface Step {
  id?: string;
  name?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface CalledWorkflow {
  on: { workflow_call?: { secrets?: Record<string, { required?: boolean }> } | null };
  jobs: Record<string, { steps: Step[] }>;
}
interface CallerJob {
  uses?: string;
  secrets?: Record<string, string> | "inherit";
}

const root = join(import.meta.dir, "../..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const declaredSecrets = (rel: string): Record<string, { required?: boolean }> | undefined =>
  (parseYaml(read(rel)) as CalledWorkflow).on.workflow_call?.secrets;
// The steps that write to the repository, each bound to the run's own token.
const releaseWorkflows: Record<string, { step: string; binding: "with.token" | "env.GH_TOKEN" }[]> =
  {
    ".github/workflows/fleet-release.yml": [
      { step: "cut", binding: "with.token" },
      { step: "propose", binding: "with.token" },
    ],
    ".github/workflows/fleet-release-publish.yml": [
      { step: "Publish the GitHub release", binding: "env.GH_TOKEN" },
    ],
  };

const skeleton = parseYaml(
  read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
) as {
  jobs: Record<string, CallerJob>;
};
const platformCall = /^owner\/repo-platform\/(\.github\/workflows\/[^@]+)@stable$/;
const platformCalls = Object.entries(skeleton.jobs)
  .map(([jobId, job]) => ({ jobId, job, rel: (job.uses ?? "").match(platformCall)?.[1] }))
  .filter((call): call is { jobId: string; job: CallerJob; rel: string } => call.rel !== undefined);

describe("the release workflows' secrets", () => {
  test("every secret the skeleton passes to a platform workflow is one it declares", () => {
    expect(platformCalls.length).toBeGreaterThan(0);
    for (const { jobId, job, rel } of platformCalls) {
      const passed = typeof job.secrets === "object" ? Object.keys(job.secrets) : [];
      const declared = Object.keys(declaredSecrets(rel) ?? {});
      for (const name of passed) expect(declared, `${jobId} -> ${rel}`).toContain(name);
    }
  });

  test.each(Object.entries(releaseWorkflows))(
    "%s is passed no secret, declares none, and writes with github.token",
    (rel, writers) => {
      const callers = platformCalls.filter((call) => call.rel === rel);
      expect(callers.map(({ job }) => job.secrets)).toEqual([undefined]);
      const doc = parseYaml(read(rel)) as CalledWorkflow;
      expect(doc.on.workflow_call?.secrets).toBeUndefined();
      expect(read(rel)).not.toMatch(/secrets\./);
      const steps = Object.values(doc.jobs).flatMap((job) => job.steps);
      const bindings = writers.map(({ step, binding }) => {
        const found = steps.find((s) => s.id === step || s.name === step);
        const [block, key] = binding.split(".") as ["with" | "env", string];
        return { step, token: found?.[block]?.[key] };
      });
      expect(bindings).toEqual(writers.map(({ step }) => ({ step, token: "${{ github.token }}" })));
    },
  );
});
