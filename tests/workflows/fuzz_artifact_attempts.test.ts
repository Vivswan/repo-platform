// The fuzzer starter's report job over a re-run night. What would drift silently: a run keeps the artifacts of every
// attempt (the artifact toolkit's listing is the run's, de-duplicated by name alone), so a download wider than the
// attempt the fuzz job last ran in files an earlier attempt's failures as tonight's. A re-run of the report job
// alone keeps the fuzz job's outputs and artifacts of the earlier attempt, which the report must still read.

import { expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { interpolate } from "../shared/github_expression.ts";
import { shippedSource } from "../shared/shipped_source.ts";

interface Step {
  name?: string;
  with?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, { outputs?: Record<string, string>; steps: Step[] }>;
}

const { fuzz, report } = (
  parseYaml(shippedSource("files/fuzzer/.github/workflows/nightly-fuzz.yml")) as Workflow
).jobs;

const inputs = (steps: Step[], name: string): Record<string, string> =>
  steps.find((step) => step.name === name)?.with ?? {};

/** What the report job downloads and names in the issue, after the fuzz job failed in each of `fuzzAttempts` and the
 *  report job runs in `reportAttempt`. */
function reported(fuzzAttempts: string[], reportAttempt: string, outputsRecorded: boolean) {
  const fuzzContext = (attempt: string) => ({ "github.run_attempt": attempt });
  const inRun = fuzzAttempts.map((attempt) =>
    interpolate(inputs(fuzz.steps, "Upload failure artifacts").name, fuzzContext(attempt)),
  );
  const lastFuzz = fuzzContext(fuzzAttempts[fuzzAttempts.length - 1]);
  const context: Record<string, string> = {
    "github.run_attempt": reportAttempt,
    "needs.fuzz.result": "failure",
  };
  for (const [name, value] of Object.entries(outputsRecorded ? (fuzz.outputs ?? {}) : {})) {
    context[`needs.fuzz.outputs.${name}`] = interpolate(value, lastFuzz);
  }
  const pattern = new Bun.Glob(
    interpolate(inputs(report.steps, "Download the failure artifacts").pattern, context),
  );
  return {
    downloaded: inRun.filter((name) => pattern.match(name)),
    named: interpolate(
      inputs(report.steps, "File or update the fuzz issue")["artifact-name"],
      context,
    ),
  };
}

test.each([
  ["a first run", ["1"], "1", true, "fuzz-failures-1"],
  ["a re-run of the whole night", ["1", "2"], "2", true, "fuzz-failures-2"],
  ["a re-run of the report job alone", ["1"], "2", true, "fuzz-failures-1"],
  ["a fuzz job that recorded no output", ["1"], "1", false, "fuzz-failures-1"],
])(
  "%s: the report downloads and names the one artifact of the fuzz job's last attempt",
  (_night, fuzzAttempts, reportAttempt, outputsRecorded, artifact) => {
    expect(reported(fuzzAttempts, reportAttempt, outputsRecorded)).toEqual({
      downloaded: [artifact],
      named: artifact,
    });
  },
);
