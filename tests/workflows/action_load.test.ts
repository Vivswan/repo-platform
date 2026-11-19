// GitHub's loader judges an action's manifest when a job naming it starts, and no offline check reads the manifests with
// that loader. So every shipped action is named by a step of a gating job in ci.yml on every push and pull request, or
// the fleet is the first to load it, via `stable`.
//   dependency-review -> pull requests only: its upstream action refuses every other event
//   autofix           -> pull requests only: every phase reads the pull request from the event
//   release-assets    -> never: it reads a draft release by its id, and this repository cuts no releases
//   npm-publish       -> never: it publishes a package to npm, and this repository has none

// `shipped` is the platform's own manifest walk, nested actions included, so this test and the shipping read one list.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CHECK_NAME } from "../../.github/scripts/shared/all_green.ts";
import { actionManifestPaths } from "../../scripts/lib/action_steps";
import { REPO_ROOT } from "../shared/action_step";
import {
  conditionSource,
  contextReads,
  evaluateCondition,
  parseExpression,
} from "../shared/github_expression.ts";

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

const shipped = actionManifestPaths(join(REPO_ROOT, "actions")).map(dirname);
const ci = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};

/** The events a step runs on, read by evaluating its job's condition and its own for a push and for a pull request, so
 *  a status function or the expression delimiters decide nothing. A step or job under continue-on-error fails to load
 *  without failing the gate, so it judges nothing. */
function runsOn(job: Job, step: Step): string {
  const advisory = (owner: Job | Step) =>
    owner["continue-on-error"] !== undefined && owner["continue-on-error"] !== false;
  if (advisory(job) || advisory(step)) return "under continue-on-error";
  const conditions = [job.if, step.if].flatMap((condition) =>
    condition === undefined ? [] : [conditionSource(condition)],
  );
  // The event's name is all the evaluation knows: a condition reading anything else is never read as covering an event.
  const readsTheEventAlone = conditions.every((condition) =>
    contextReads(parseExpression(condition).tree).every(
      (read) => read.join(".") === "github.event_name",
    ),
  );
  const holdsOn = (event: string) =>
    readsTheEventAlone &&
    conditions.every((condition) => evaluateCondition(condition, { "github.event_name": event }));
  if (holdsOn("push") && holdsOn("pull_request")) return "every event";
  return holdsOn("pull_request") ? "pull requests" : `when ${conditions.join(" and ")}`;
}

test("every shipped action is run, so loaded, by a gating job's step on every push and pull request", () => {
  const gating = ci.jobs[CHECK_NAME].needs ?? [];
  const runs = new Map<string, Set<string>>(shipped.map((name) => [name, new Set()]));
  for (const job of gating) {
    for (const step of ci.jobs[job].steps ?? []) {
      const dir = /^\$\/(actions\/.+)$/.exec(step.uses ?? "")?.[1];
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
    "actions/autofix": "pull requests",
    "actions/dependency-review": "pull requests",
    "actions/npm-publish": "never",
    "actions/release-assets": "never",
  });
});
