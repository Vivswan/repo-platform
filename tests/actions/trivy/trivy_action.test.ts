// The facts the trivy action's manifest shares with fleet.yml and Trivy, which neither can see: the fleet's trivy step
// calls the action bare, so the manifest's one scan is what every repository runs; the exit code and the ignore file
// are explicit because Trivy otherwise reads them from the repository (a trivy.yaml with `exit-code: 1` would turn a
// finding red, a .trivyignore would silence one); and the annotate step reads the file the scan wrote.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "../../..");
const read = (rel: string) => parseYaml(readFileSync(join(ROOT, rel), "utf8"));

interface Step {
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

test("fleet.yml's trivy step calls the action bare; its one scan is green on a finding, reads no repository ignore file, and feeds the annotate step", () => {
  const action = read("actions/trivy/action.yml") as { runs: { steps: Step[] } };
  const fleet = read(".github/workflows/fleet.yml") as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const callers = Object.entries(fleet.jobs).flatMap(([job, { steps }]) =>
    (steps ?? []).filter((step) => step.uses === "$/actions/trivy").map((step) => [job, step.with]),
  );
  const [scan, ...moreScans] = action.runs.steps.filter((step) =>
    (step.uses ?? "").startsWith("aquasecurity/trivy-action@"),
  );
  const annotate = action.runs.steps.find((step) => (step.run ?? "").includes("annotate.ts"));
  expect({
    callers,
    moreScans,
    scan: [scan?.if, scan?.with?.["exit-code"], scan?.env?.TRIVY_IGNOREFILE, scan?.with?.format],
    annotate: [annotate?.if, annotate?.env?.RESULTS],
  }).toStrictEqual({
    callers: [["standard-checks", undefined]],
    moreScans: [],
    scan: [undefined, "0", "/dev/null", "json"],
    annotate: [undefined, scan?.with?.output],
  });
});
