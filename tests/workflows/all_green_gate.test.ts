// The gate judges only what its `needs` list names, and GitHub has no "needs every job", so a gating job dropped from
// the list keeps running and gates nothing; the list is compared with the job set here. The check's NAME is GitHub's
// literal surface too: a renamed gate job leaves branch protection waiting forever while every job stays green.
//
//   name: or strategy: on the gate  -> the check run posts under that name or a matrix suffix, never as the required context
//   if: other than always()         -> a failed dependency SKIPS the gate, and GitHub reads a skipped required check as satisfied

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CHECK_NAME } from "../../.github/scripts/shared/all_green.ts";
import { PLATFORM_OWNER } from "../../actions/shared/platform.ts";

interface Job {
  needs?: string | string[];
  if?: string;
  name?: string;
  strategy?: unknown;
}
interface Ruleset {
  name: string;
  rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
}

const ROOT = join(import.meta.dir, "../..");
const read = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8").replaceAll("{{github_username}}", PLATFORM_OWNER);
const jobsOf = (rel: string) => (parseYaml(read(rel)) as { jobs: Record<string, Job> }).jobs;
const needsOf = (job: Job | undefined): string[] =>
  typeof job?.needs === "string" ? [job.needs] : (job?.needs ?? []);

const ci = jobsOf(".github/workflows/ci.yml");
const skeleton = jobsOf("files/base/.github/workflows/ci.yml");

test("ci.yml's gate needs exactly the jobs that do not ride behind it", () => {
  const reachesGate = (name: string, seen = new Set<string>()): boolean =>
    needsOf(ci[name]).some(
      (dep) => dep === CHECK_NAME || (!seen.has(dep) && reachesGate(dep, seen.add(dep))),
    );
  const gating = Object.keys(ci).filter((name) => name !== CHECK_NAME && !reachesGate(name));
  expect(needsOf(ci[CHECK_NAME]).sort()).toEqual(gating.sort());
});

test("both gate jobs post the check as CHECK_NAME, fail closed, and the override ruleset requires that context", () => {
  const { rulesets } = parseYaml(read("files/settings/override.yml")) as { rulesets: Ruleset[] };
  const contexts = rulesets
    .find((ruleset) => ruleset.name === "main")
    ?.rules.find((rule) => rule.type === "required_status_checks")
    ?.parameters?.required_status_checks?.map((check) => check.context);
  const gate = (jobs: Record<string, Job>) => {
    const job = jobs[CHECK_NAME];
    return job === undefined
      ? "no such job"
      : { name: job.name, strategy: job.strategy, if: String(job.if ?? "").trim() };
  };
  const posted = { name: undefined, strategy: undefined, if: "always()" };
  expect({ ci: gate(ci), skeleton: gate(skeleton), contexts }).toEqual({
    ci: posted,
    skeleton: posted,
    contexts: [CHECK_NAME],
  });
});
