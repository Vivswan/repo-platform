// The fleet runs on one runner label: GitHub bills an ARM minute below an x64 one, so a job back on `ubuntu-latest`
// costs more on every push fleet-wide and nothing turns red. The exceptions are the jobs whose tool ships no arm64
// Linux build, each with its reason, so a new one is a conscious entry here (docs/fleet-guidelines.md, "ARM runners
// by default").

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isManaged } from "../../actions/shared/managed_header.ts";
import { PLATFORM_OWNER } from "../../actions/shared/platform.ts";

interface Job {
  "runs-on"?: string;
}

/** The repository root the globs and reads resolve against. */
const ROOT = join(import.meta.dir, "../..");

/** The one runner label every platform job runs on. */
export const FLEET_RUNNER = "ubuntu-24.04-arm";

/** The platform's own workflows and every module's shipped sources. */
const WORKFLOW_GLOBS = [".github/workflows/*.{yml,yaml}", "files/*/.github/workflows/*.{yml,yaml}"];

/** `<workflow path>#<job>` -> the x64 runner and why the job stays on it. */
const X64_JOBS: Record<string, { runner: string; reason: string }> = {
  ".github/workflows/ci.yml#script-tests": {
    runner: "ubuntu-latest",
    reason: "the theme tests drive headless Chrome, which the ARM image omits",
  },
  "files/base/.github/workflows/copilot-setup-steps.yml#copilot-setup-steps": {
    runner: "ubuntu-latest",
    reason: "the Copilot coding agent runs its setup job on Ubuntu x64 alone",
  },
};

/** The writer's placeholders become YAML first (the owner slug, the `{{blocks}}` line, any other token as a word). A
 *  toolchain step fragment has no `jobs:`, and a managed root copy is judged under files/ until the self-sync rewrites it. */
function loadJobs(rel: string): Record<string, Job> {
  const source = readFileSync(join(ROOT, rel), "utf8");
  if (rel.startsWith(".github/workflows/") && isManaged(source)) return {};

  const text = source
    .replaceAll("{{github_username}}", PLATFORM_OWNER)
    .replace(/^\{\{blocks\}\}$/gm, "")
    .replace(/\{\{[\w-]+\}\}/g, "placeholder");
  return (parseYaml(text) as { jobs?: Record<string, Job> } | null)?.jobs ?? {};
}

const jobs = WORKFLOW_GLOBS.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })])
  .sort()
  .flatMap((path) =>
    Object.entries(loadJobs(path))
      .filter(([, job]) => job["runs-on"] !== undefined)
      .map(([name, job]) => ({ site: `${path}#${name}`, job })),
  );

describe("the fleet's runner label", () => {
  test("every job runs on the fleet runner, except the jobs listed with their x64 reason", () => {
    const runners = Object.fromEntries(jobs.map(({ site, job }) => [site, job["runs-on"]]));
    const expected = Object.fromEntries(
      jobs.map(({ site }) => [site, X64_JOBS[site]?.runner ?? FLEET_RUNNER]),
    );
    expect(runners).toEqual(expected);
  });

  test("every x64 exception names a job that exists", () => {
    const sites = new Set(jobs.map(({ site }) => site));
    expect(Object.keys(X64_JOBS).filter((site) => !sites.has(site))).toEqual([]);
  });
});
