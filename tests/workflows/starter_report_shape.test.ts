// GitHub's step rule simulated over the nightly starters' report jobs: a step's bare condition implies success() over
// every step before it, so a step that can run on the same night as an earlier step is skipped when that earlier step
// fails, and the night goes silent. The fuzzer starter's filing step follows the artifact download (cloud-speech's
// fold found it skipped after a failed download); the nightly starter's two steps are exclusive and need nothing.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { evaluateCondition, hasStatusFunction } from "../shared/github_expression.ts";

interface Step {
  name?: string;
  if?: string;
}
interface Job {
  needs?: string[];
  steps?: Step[];
}

const ROOT = join(import.meta.dir, "../..");
const RESULTS = ["success", "failure", "cancelled", "skipped"];
const reportJob = (rel: string) =>
  (
    parseYaml(
      readFileSync(join(ROOT, rel), "utf8").replaceAll(/\{\{[\w]+\}\}/g, "placeholder"),
    ) as { jobs: Record<string, Job> }
  ).jobs.report;

const contexts = (needs: string[]): Record<string, string>[] =>
  needs.reduce<Record<string, string>[]>(
    (acc, need) =>
      acc.flatMap((context) =>
        RESULTS.map((result) => ({ ...context, [`needs.${need}.result`]: result })),
      ),
    [{}],
  );

test.each([
  ["files/nightly/.github/workflows/nightly.yml"],
  ["files/fuzzer/.github/workflows/nightly-fuzz.yml"],
])(
  "%s: a report step that can run on the same night as an earlier step carries a status function",
  (rel) => {
    const job = reportJob(rel);
    const steps = job.steps ?? [];
    const nights = contexts(job.needs ?? []);
    const runs = (step: Step, night: Record<string, string>) =>
      step.if === undefined || evaluateCondition(step.if, night);
    const gaps: string[] = [];
    for (const [at, later] of steps.entries()) {
      if (hasStatusFunction(later.if ?? "")) continue;
      const earlier = steps
        .slice(0, at)
        .filter((step) => nights.some((night) => runs(step, night) && runs(later, night)));
      for (const step of earlier) gaps.push(`'${later.name}' after '${step.name}'`);
    }
    expect({ steps: steps.length > 1, gaps }).toEqual({ steps: true, gaps: [] });
  },
);
