// The all-green gate's judgment, run as the REAL run block of
// actions/all-green/action.yml (never a copy, so nothing here can drift
// from what ships) under the runner's bash, one needs payload per case.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const ACTION = join(import.meta.dir, "../../actions/all-green/action.yml");
const JUDGE_STEP = "Judge every needed result";
// How the runner invokes a composite step's `shell: bash` script.
const RUNNER_BASH = ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c"];

type Step = Record<string, unknown>;
const action = parseYaml(readFileSync(ACTION, "utf8"));
const judge = (action.runs.steps as Step[]).find((step) => step.name === JUDGE_STEP);
if (judge === undefined || typeof judge.run !== "string") {
  throw new Error(`${ACTION}: no '${JUDGE_STEP}' step with a run block - anchor lost`);
}
const run = judge.run;

/** The judge's own environment: NEEDS only, PATH for bash and jq. */
const judged = (needs: string) =>
  boundedSpawnSync([...RUNNER_BASH, run], { env: { PATH: process.env.PATH, NEEDS: needs } });

type Results = Record<string, string | null>;
const needsOf = (results: Results): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }]),
    ),
  );
const census = (results: Results): string[] =>
  Object.entries(results).map(([job, result]) => `- ${job}: ${result}`);

describe("the all-green judgment", () => {
  test("the judge step reads the needs input from NEEDS under the runner's bash", () => {
    expect({ shell: judge.shell, env: judge.env, needs: action.inputs.needs.required }).toEqual({
      shell: "bash",
      env: { NEEDS: "${{ inputs.needs }}" },
      needs: true,
    });
  });

  // Whole stdout per scenario: the census in needs order, then the one
  // verdict line; an empty stderr proves the exit code is the verdict's
  // own and not an incidental crash on the way there.
  test.each<{ name: string; results: Results; exitCode: number; verdict: string }>([
    {
      name: "every needed job succeeded",
      results: { checks: "success", ci: "success" },
      exitCode: 0,
      verdict: "all green: 2 of 2 gating jobs succeeded, the rest stood down",
    },
    {
      name: "a skipped job stands down next to a success",
      results: { checks: "success", ci: "skipped" },
      exitCode: 0,
      verdict: "all green: 1 of 2 gating jobs succeeded, the rest stood down",
    },
    {
      name: "one failure fails, naming the job",
      results: { checks: "success", ci: "failure" },
      exitCode: 1,
      verdict: "::error::gating jobs did not succeed: ci (failure).",
    },
    {
      name: "cancelled is not a green shape",
      results: { checks: "success", ci: "cancelled" },
      exitCode: 1,
      verdict: "::error::gating jobs did not succeed: ci (cancelled).",
    },
    {
      name: "all skipped vouches for nothing",
      results: { checks: "skipped", ci: "skipped" },
      exitCode: 1,
      verdict:
        "::error::no gating job actually succeeded - an all-skipped run vouches for nothing, so the gate fails closed.",
    },
    {
      name: "an empty needs context is no gate at all",
      results: {},
      exitCode: 1,
      verdict:
        "::error::the all-green job needs nothing - an empty needs list vouches for no gate at all; list every gating job.",
    },
    {
      name: "a null result fails closed",
      results: { ci: null },
      exitCode: 1,
      verdict: "::error::gating jobs did not succeed: ci (null).",
    },
  ])("$name", ({ results, exitCode, verdict }) => {
    const outcome = judged(needsOf(results));
    expect([outcome.exitCode, outcome.stdout, outcome.stderr]).toEqual([
      exitCode,
      `${[...census(results), verdict].join("\n")}\n`,
      "",
    ]);
  });

  // The first jq crashes under errexit before any census line prints;
  // only never-zero matters for the code (jq's own varies by version).
  // The job-shaped ARRAY is the sharp case: to_entries walks arrays too
  // (index-keyed), so without the explicit object check it would read as
  // one green job.
  test.each([
    { name: "malformed input", needs: "not json" },
    { name: "non-object input", needs: '["success"]' },
    { name: "job-shaped array input", needs: '[{"result": "success", "outputs": {}}]' },
  ])("$name fails closed before judging anything", ({ needs }) => {
    const outcome = judged(needs);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toStartWith("jq: ");
  });
});
