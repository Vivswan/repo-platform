// The one coupling the split into two actions can no longer express in
// either place: the re-armer re-runs the gate job BY NAME, and that name is
// a constant in rerun.ts while the job it names is rendered by ci.yml.jinja.
//
// It used to be pinned in the rendered workflow, which carried the name as a
// GATE_JOB env var next to the bash that used it, so a rename showed up in
// one file. Now a rename of either side alone leaves both suites green, both
// workflows valid, and the re-arm silently unable to find the job it exists
// to re-run - which surfaces as gates that never recover, not as a failure.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const RENDERS = join(import.meta.dir, "../golden-renders");
const GOLDENS = ["minimal", "all-modules", "uv-no-release-please"];

/** The job name rerun.ts re-runs, read out of the action's own source so
 * the test cannot drift from it the way a second literal would. */
function gateJobName(): string {
  const source = readFileSync(
    join(import.meta.dir, "../../actions/copilot-rearm/rerun.ts"),
    "utf8",
  );
  const match = /^const GATE_JOB = "([^"]+)";$/m.exec(source);
  if (match === null) throw new Error("rerun.ts no longer declares a GATE_JOB constant");
  return match[1];
}

describe("the rendered Copilot bridge", () => {
  for (const golden of GOLDENS) {
    test(`${golden} renders the job the re-armer re-runs`, () => {
      const ci = parseYaml(
        readFileSync(join(RENDERS, golden, ".github/workflows/ci.yml"), "utf8"),
      ) as { jobs: Record<string, unknown> };
      expect(Object.keys(ci.jobs)).toContain(gateJobName());
    });
  }
});
