// What would drift silently: a job shipped with a fixed runner. A private repository that set CI_RUNS_ON would still
// queue that one job on a GitHub-hosted runner, and its gate would never go green (docs/fleet-guidelines.md, "Runner").
// Judged over every workflow a managed repository's run executes: the sources under files/ and each platform workflow
// they call, followed through the `uses:` lines so a new workflow is judged without being registered here.

import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { interpolate } from "../shared/github_expression.ts";
import { shippedSource } from "../shared/shipped_source.ts";
import {
  calledWorkflow,
  shippedWorkflowFiles,
  WORKFLOW_FRAGMENTS,
} from "../shared/shipped_workflows.ts";

interface Job {
  uses?: string;
  "runs-on"?: unknown;
}

/** The one line, character for character. */
const RUNS_ON = "${{ github.event.repository.private && vars.CI_RUNS_ON || 'ubuntu-latest' }}";

/** Copilot reads this job's `runs-on` itself, and its documentation names labels only, so the job keeps a plain one. */
const PLAIN_LABEL = new Set(["files/base/.github/workflows/copilot-setup-steps.yml"]);

/** The workflows a target receives whole. */
const sources = shippedWorkflowFiles().filter((rel) => !WORKFLOW_FRAGMENTS.has(rel));

/** A workflow's jobs by id, as a target's copy parses. */
const jobsOf = (rel: string) =>
  Object.entries((parseYaml(shippedSource(rel)) as { jobs: Record<string, Job> }).jobs);

/** The sources and every platform workflow reached from them, each once. */
function executed(): string[] {
  const seen = new Set(sources);
  const queue = [...sources];
  for (let rel = queue.pop(); rel !== undefined; rel = queue.pop()) {
    for (const [, job] of jobsOf(rel)) {
      // A source's `./` call names another source, whichever module ships it, and every source is walked already.
      const called = calledWorkflow(job.uses ?? "", dirname(rel));
      if (called === null || called.startsWith("files/") || seen.has(called)) continue;

      seen.add(called);
      queue.push(called);
    }
  }
  return [...seen].sort();
}

/** Each job whose runner is not the one expression, as `file: job 'id'`. */
function fixedRunners(rel: string): string[] {
  return jobsOf(rel).flatMap(([id, job]) =>
    job.uses === undefined && job["runs-on"] !== RUNS_ON ? [`${rel}: job '${id}'`] : [],
  );
}

describe("every shipped job takes its runner from the one expression", () => {
  const files = executed();

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
