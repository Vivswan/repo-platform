// The gate judges only what its `needs` list names, and GitHub has no "needs every job", so a gating job dropped from
// the list keeps running and gates nothing; the list is compared with the job set here. The check's NAME is GitHub's
// literal surface too: a renamed gate job leaves branch protection waiting forever while every job stays green.
//
//   name: or strategy: on the gate  -> the check run posts under that name or a matrix suffix, never as the required context
//   if: other than always()         -> a failed dependency SKIPS the gate, and GitHub reads a skipped required check as satisfied
//   a conditional job off allowed-skips -> its skip fails the gate on every run its condition excludes
//
// The skeleton's one exception is a private repository's nightly, which runs no job: its gate stands down on that
// run alone, by an event and a visibility no failed dependency changes. A needed job that runs wherever the gate
// does never skips under it, so it stays off allowed-skips and an all-skipped run still cannot pass.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CHECK_NAME } from "../../.github/scripts/shared/all_green.ts";
import { sectionEntries } from "../../.github/scripts/sync/writer/settings_layers.ts";
import { PLATFORM_OWNER } from "../../actions/shared/platform.ts";
import { calledFunctions, evaluateCondition } from "../shared/github_expression.ts";

interface Job {
  needs?: string | string[];
  if?: string;
  name?: string;
  strategy?: unknown;
  steps?: { with?: { "allowed-skips"?: string } }[];
}
type Rule = { type: string; parameters?: { required_status_checks?: { context: string }[] } };

const ROOT = join(import.meta.dir, "../..");
const read = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8").replaceAll("{{github_username}}", PLATFORM_OWNER);

/** One run a workflow can start: a trigger it declares, in a public or a private repository. */
interface Run {
  event: string;
  isPrivate: boolean;
}

interface Workflow {
  jobs: Record<string, Job>;
  runs: Run[];
}

/** The workflow's jobs and every run it can start. */
function workflowOf(rel: string): Workflow {
  const { on, jobs } = parseYaml(read(rel)) as { on: object; jobs: Record<string, Job> };
  const runs = Object.keys(on).flatMap((event) => [
    { event, isPrivate: false },
    { event, isPrivate: true },
  ]);
  return { jobs, runs };
}

/** Whether the job's condition lets it run, its needs aside; a condition reading `needs` is refused by the parser. */
function runsOn(job: Job | undefined, run: Run): boolean {
  if (job?.if === undefined) return true;

  return evaluateCondition(job.if, {
    "github.event_name": run.event,
    "github.event.repository.private": run.isPrivate,
  });
}

const needsOf = (job: Job | undefined): string[] =>
  typeof job?.needs === "string" ? [job.needs] : (job?.needs ?? []);

const ownCi = workflowOf(".github/workflows/ci.yml");
const fleetCi = workflowOf("files/base/.github/workflows/ci.yml");
const ci = ownCi.jobs;

test("ci.yml's gate needs exactly the jobs that do not ride behind it", () => {
  const reachesGate = (name: string, seen = new Set<string>()): boolean =>
    needsOf(ci[name]).some(
      (dep) => dep === CHECK_NAME || (!seen.has(dep) && reachesGate(dep, seen.add(dep))),
    );
  const gating = Object.keys(ci).filter((name) => name !== CHECK_NAME && !reachesGate(name));
  expect(needsOf(ci[CHECK_NAME]).sort()).toEqual(gating.sort());
});

test.each([
  ["ci.yml", ownCi],
  ["the skeleton", fleetCi],
])(
  "%s's allowed-skips names exactly the needed jobs that skip on a run the gate judges",
  (_, { jobs, runs }) => {
    const judged = runs.filter((run) => runsOn(jobs[CHECK_NAME], run));
    const conditional = needsOf(jobs[CHECK_NAME]).filter((name) =>
      judged.some((run) => !runsOn(jobs[name], run)),
    );
    const allowed = jobs[CHECK_NAME]?.steps
      ?.map((step) => step.with?.["allowed-skips"])
      .find((value) => value !== undefined);
    expect(allowed?.split(/[\s,]+/).sort()).toEqual(conditional.sort());
  },
);

test("both gate jobs post the check as CHECK_NAME, fail closed, and the override ruleset requires that context", () => {
  const main = sectionEntries(parseYaml(read("files/settings/override.yml")), "rulesets").find(
    (ruleset) => ruleset.name === "main",
  );
  const contexts = (main?.rules as Rule[] | undefined)
    ?.find((rule) => rule.type === "required_status_checks")
    ?.parameters?.required_status_checks?.map((check) => check.context);
  const gate = ({ jobs, runs }: Workflow) => {
    const job = jobs[CHECK_NAME];
    return job === undefined
      ? "no such job"
      : {
          name: job.name,
          strategy: job.strategy,
          functions: calledFunctions(String(job.if ?? "")),
          standsDownOn: runs.filter((run) => !runsOn(job, run)),
        };
  };
  const posted = { name: undefined, strategy: undefined, functions: ["always"], standsDownOn: [] };
  expect({ ci: gate(ownCi), skeleton: gate(fleetCi), contexts }).toEqual({
    ci: posted,
    skeleton: { ...posted, standsDownOn: [{ event: "schedule", isPrivate: true }] },
    contexts: [CHECK_NAME],
  });
});
