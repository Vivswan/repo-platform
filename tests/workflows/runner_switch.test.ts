// What would drift silently: a job shipped with a fixed runner. A private repository that set CI_RUNS_ON would still
// queue that one job on a GitHub-hosted runner, and its gate would never go green (docs/fleet-guidelines.md, "Runner").
// Judged over every workflow a managed repository's run executes (executedWorkflowFiles).

import { describe, expect, test } from "bun:test";
import { interpolate } from "../shared/github_expression.ts";
import { executedWorkflowFiles, shippedJobs } from "../shared/shipped_workflows.ts";

interface Job {
  uses?: string;
  "runs-on"?: unknown;
}

/** The one line, character for character. */
const RUNS_ON = "${{ github.event.repository.private && vars.CI_RUNS_ON || 'ubuntu-latest' }}";

/** Copilot reads this job's `runs-on` itself, and its documentation names labels only, so the job keeps a plain one. */
const PLAIN_LABEL = new Set(["files/base/.github/workflows/copilot-setup-steps.yml"]);

/** Each job whose runner is not the one expression, as `file: job 'id'`. */
function fixedRunners(rel: string): string[] {
  return shippedJobs<Job>(rel).flatMap(([id, job]) =>
    job.uses === undefined && job["runs-on"] !== RUNS_ON ? [`${rel}: job '${id}'`] : [],
  );
}

describe("every shipped job takes its runner from the one expression", () => {
  const files = executedWorkflowFiles();

  test("the walk reaches the starters, the skeleton's calls, and a call's own call (ARMED)", () => {
    expect(files).toContain("files/base/.github/workflows/checks.yml");
    expect(files).toContain(".github/workflows/fleet.yml");
    expect(files).toContain(".github/workflows/reusable-codeql.yml");
    expect(files).not.toContain(".github/workflows/ci.yml");
  });

  test.each(files.filter((rel) => !PLAIN_LABEL.has(rel)))("%s", (rel) => {
    expect(fixedRunners(rel)).toEqual([]);
  });
});

describe("the expression sends only a private repository's job to its own runner", () => {
  test.each<{ shape: string; context: Record<string, string | boolean>; runner: string }>([
    {
      shape: "private, the variable unset",
      context: { "github.event.repository.private": true, "vars.OTHER": "x" },
      runner: "ubuntu-latest",
    },
    {
      shape: "private, the variable set",
      context: { "github.event.repository.private": true, "vars.CI_RUNS_ON": "self-hosted" },
      runner: "self-hosted",
    },
    {
      shape: "private, the variable empty",
      context: { "github.event.repository.private": true, "vars.CI_RUNS_ON": "" },
      runner: "ubuntu-latest",
    },
    {
      shape: "public, the variable set",
      context: { "github.event.repository.private": false, "vars.CI_RUNS_ON": "self-hosted" },
      runner: "ubuntu-latest",
    },
    {
      shape: "public, the variable unset",
      context: { "github.event.repository.private": false, "vars.OTHER": "x" },
      runner: "ubuntu-latest",
    },
    {
      shape: "an event carrying no repository, the variable set",
      context: { "github.event_name": "schedule", "vars.CI_RUNS_ON": "self-hosted" },
      runner: "ubuntu-latest",
    },
  ])("$shape -> $runner", ({ context, runner }) => {
    expect(interpolate(RUNS_ON, context)).toBe(runner);
  });
});
