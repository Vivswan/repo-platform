// GitHub's loader judges a local action's manifest only when a step runs it (a `./actions/<name>` step whose `if:` is false
// loads nothing), and no offline check reads the manifests with that loader. So every shipped action is run by a step of
// a gating job in ci.yml on every push and pull request, or the fleet is the first to load it, via `stable`.
//   dependency-review -> pull requests only: its upstream action refuses every other event
//   release-assets    -> never: it reads a draft release by tag, and this repository cuts no releases

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CHECK_NAME } from "../../.github/scripts/shared/all_green.ts";
import { actionManifestPaths } from "../../scripts/lib/action_steps";
import { REPO_ROOT } from "../shared/action_step";

interface Step {
  uses?: string;
  if?: string;
  "continue-on-error"?: boolean | string;
}
interface Job {
  needs?: string[];
  if?: string;
  "continue-on-error"?: boolean | string;
  steps?: Step[];
}

const PULL_REQUESTS_ONLY = "github.event_name == 'pull_request'";
// The recursive manifest walk, so a nested action is shipped and judged by the same list.
const shipped = actionManifestPaths(join(REPO_ROOT, "actions")).map(dirname);
const ci = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};

/** A step or job under continue-on-error fails to load without failing the gate, so it judges nothing;
 *  an expression there is read as such, since nothing here can evaluate it. */
function runsOn(job: Job, step: Step): string {
  const advisory = (owner: Job | Step) =>
    owner["continue-on-error"] !== undefined && owner["continue-on-error"] !== false;
  if (advisory(job) || advisory(step)) return "under continue-on-error";
  const narrowing = [job.if, step.if]
    .map((condition) => (condition ?? "").trim())
    .filter((condition) => condition !== "" && condition !== "always()")
    .map((condition) => (condition === PULL_REQUESTS_ONLY ? "pull requests" : `when ${condition}`));
  return narrowing.length === 0 ? "every event" : narrowing.join(" and ");
}

test("every shipped action is run, so loaded, by a gating job's step on every push and pull request", () => {
  const gating = ci.jobs[CHECK_NAME].needs ?? [];
  const runs = new Map<string, Set<string>>(shipped.map((name) => [name, new Set()]));
  for (const job of gating) {
    for (const step of ci.jobs[job].steps ?? []) {
      const dir = /^\.\/(actions\/.+)$/.exec(step.uses ?? "")?.[1];
      if (dir !== undefined) runs.get(dir)?.add(runsOn(ci.jobs[job], step));
    }
  }
  const judged = Object.fromEntries(
    [...runs].map(([name, when]) => [
      name,
      when.has("every event") ? "every event" : [...when].sort().join(", ") || "never",
    ]),
  );
  expect(judged).toEqual({
    ...Object.fromEntries(shipped.map((dir) => [dir, "every event"])),
    "actions/dependency-review": "pull requests",
    "actions/release-assets": "never",
  });
});
