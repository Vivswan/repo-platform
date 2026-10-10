// GitHub's job-skip rules simulated over the parsed post-green graph, so a reworded condition is judged whatever its
// spelling: a condition with no status function implies success() over the WHOLE ancestry, and an unrun need is skipped
// with empty outputs. The push lane is a regression pin (#207), cross-file with the skeleton every fleet repository runs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { truthy } from "@actions/expressions/result";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

interface Job {
  needs?: string[];
  if?: string;
}
interface Concurrency {
  group: string;
  queue: string;
  "cancel-in-progress": string | boolean;
}

// The status functions are the workflow runner's, not the expression language's: a job whose condition passed is judged
// here only when its chain ran or a status function let it continue, so always() reads true and cancelled() false.
const STATUS_FUNCTIONS = new Map(
  [
    ["always", true],
    ["cancelled", false],
  ].map(([name, value]) => [
    String(name),
    {
      name: String(name),
      minArgs: 0,
      maxArgs: 0,
      call: () => new data.BooleanData(Boolean(value)),
    },
  ]),
);

/** GitHub's own expression language over a context of dotted keys; a key nobody set reads as null, as an unrun job's
 *  output does in Actions. */
function evaluateCondition(expression: string, context: Record<string, string>): boolean {
  const contexts = new data.Dictionary();
  for (const [path, value] of Object.entries(context)) {
    const keys = path.split(".");
    let node = contexts;
    for (const key of keys.slice(0, -1)) {
      const child = node.get(key) ?? new data.Dictionary();
      if (!(child instanceof data.Dictionary)) throw new Error(`${path}: ${key} is not a mapping`);
      if (node.get(key) === undefined) node.add(key, child);
      node = child;
    }
    node.add(keys[keys.length - 1], new data.StringData(value));
  }
  const tokens = new Lexer(expression).lex().tokens;
  const tree = new Parser(
    tokens,
    contexts.pairs().map((pair) => pair.key),
    [...STATUS_FUNCTIONS.values()],
  ).parse();
  return truthy(new Evaluator(tree, contexts, STATUS_FUNCTIONS).evaluate());
}

/** Simulates GitHub's own rules, which the body mirrors; `outputs` stands in for the step outputs
 * of every job that ran. "A failure or skip applies to all jobs in the dependency chain from the
 * point of failure or skip onwards", even through a job a status function let continue.
 *   an unrun need                       -> result `skipped`, empty outputs
 *   a condition with no status function -> implicit success() over the WHOLE ancestry
 *   the run's ref                       -> main's head unless given (ci.yml's push trigger is filtered to main) */
function jobsRunning(
  jobs: Record<string, Job>,
  event: string,
  outputs: Record<string, string>,
  failed: string[] = [],
  ref = "refs/heads/main",
): string[] {
  const ran = new Set<string>();
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(jobs[id].needs ?? [])];
    for (let need = stack.pop(); need !== undefined; need = stack.pop()) {
      if (seen.has(need)) continue;
      seen.add(need);
      stack.push(...(jobs[need].needs ?? []));
    }
    return seen;
  };
  const pending = Object.keys(jobs);
  while (pending.length > 0) {
    const id = pending.shift() as string;
    const job = jobs[id];
    const needs = job.needs ?? [];
    if (needs.some((need) => pending.includes(need))) {
      pending.push(id);
      continue;
    }
    if (failed.includes(id)) continue;
    const context: Record<string, string> = { "github.event_name": event, "github.ref": ref };
    for (const need of needs) {
      context[`needs.${need}.result`] = ran.has(need)
        ? "success"
        : failed.includes(need)
          ? "failure"
          : "skipped";
      for (const [name, value] of Object.entries(outputs)) {
        context[`needs.${need}.outputs.${name}`] = ran.has(need) ? value : "";
      }
    }
    const condition = job.if ?? "";
    const statusFunction = /\b(always|cancelled|success|failure)\(\)/.test(condition);
    const chainRan = [...ancestors(id)].every((need) => ran.has(need));
    const passes = condition === "" || evaluateCondition(condition, context);
    if (passes && (statusFunction || chainRan)) ran.add(id);
  }
  return [...ran];
}

describe("post-green wiring", () => {
  const ciYml = read(".github/workflows/ci.yml");
  const ci = parseYaml(ciYml) as { concurrency: Concurrency; jobs: Record<string, Job> };
  const postGreenDoc = parseYaml(read(".github/workflows/post-green.yml")) as {
    jobs: Record<string, Job>;
  };

  test("a dispatch runs the mover ALONE; the call runs every leg", () => {
    const jobs = postGreenDoc.jobs;
    const armed = { armed: "true", previous: "a".repeat(40) };
    expect(jobsRunning(jobs, "workflow_dispatch", armed).sort()).toEqual(["move-stable"]);
    expect(jobsRunning(jobs, "push", armed).sort()).toEqual(Object.keys(jobs).sort());
    // No directive skips the sync and nothing else: the settings apply
    // runs on every call, its targets never derived from the sync's.
    expect(jobsRunning(jobs, "push", { ...armed, armed: "false" }).sort()).toEqual([
      "move-stable",
      "read-directives",
      "settings-fleet",
    ]);
    // A mover that moved nothing reports no base, and the read still syncs on the push's own before;
    // the mover has no word that stands the read down.
    //   a replay at the tag's own commit                 -> the judged commit alone (re-run the FAILED jobs to keep the mover's previous)
    //   a re-run after a newer commit moved the tag past -> the newer run's range, exclusive at its base, may have excluded this commit
    expect(jobsRunning(jobs, "push", { armed: "true", previous: "" }).sort()).toEqual(
      Object.keys(jobs).sort(),
    );
    // A red mover (a lost lease, a refused push) leaves the read on the push's own before and skips the
    // sync (the tag names a stale commit), nothing else.
    expect(jobsRunning(jobs, "push", { armed: "true" }, ["move-stable"]).sort()).toEqual([
      "read-directives",
      "settings-fleet",
    ]);
  });

  // One lane per ref (GitHub's Pages starter shape): main runs wait in arrival order, so queued runs deploy in order.
  // Under per-commit lanes they overlapped and a slower older run deployed after a newer one. queue: max lets up to
  // 100 runs wait, so every commit keeps its own run and verdict short of that cap; the pull-request lane stays single
  // and cancels the stale run. The skeleton every fleet repository runs carries the same block.
  test("ci.yml and the skeleton queue the runs of one ref in one lane; only pull-request lanes cancel", () => {
    const skeleton = parseYaml(
      read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
    ) as { concurrency: Concurrency };
    for (const doc of [ci, skeleton]) {
      expect(doc.concurrency).toEqual({
        group: "${{ github.workflow }}-${{ github.ref }}",
        queue: "${{ github.event_name == 'pull_request' && 'single' || 'max' }}",
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      });
    }
  });

  test("ci.yml: a push to main skips dependency-review alone, and every leg behind the gate runs (post-green skipped past a green gate, stable stalled)", () => {
    const ran = jobsRunning(ci.jobs, "push", {});
    expect(Object.keys(ci.jobs).filter((job) => !ran.includes(job))).toEqual(["dependency-review"]);
  });

  // The skeleton's legs read outputs from `platform` and gate on the results they name, and a needs edge GitHub reads as
  // an order (the site behind the release) is one it also reads as an implicit success() gate without the leading
  // !cancelled(). Either slip leaves a leg skipped forever on some event, green: the nightly rebuild, a release commit's
  // deploy, or the deploy after a red hook.
  test("the skeleton: every leg runs on a release commit's push; the schedule rebuilds the site alone; a red hook skips the release and the deploy still runs", () => {
    const skeleton = parseYaml(
      read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
    ) as { jobs: Record<string, Job> };
    const every = Object.keys(skeleton.jobs).sort();
    const released = {
      modules: '["release-please","site"]',
      release_created: "true",
      prs_created: "true",
      tag_name: "v1.2.3",
    };
    const runs = (
      event: string,
      outputs: Record<string, string>,
      failed?: string[],
      ref?: string,
    ) => jobsRunning(skeleton.jobs, event, outputs, failed, ref).sort();
    expect({
      releasePush: runs("push", released),
      plainPush: runs("push", { modules: "[]" }),
      schedule: runs("schedule", released),
      dispatch: runs("workflow_dispatch", released),
      pullRequest: runs("pull_request", released, [], "refs/pull/7/merge"),
      redHook: runs("push", released, ["post-green"]),
    }).toEqual({
      releasePush: every,
      plainPush: ["all-green", "checks", "platform", "post-green"],
      schedule: ["all-green", "platform", "site"],
      dispatch: ["all-green", "checks", "platform", "site"],
      pullRequest: ["all-green", "checks", "platform"],
      redHook: ["all-green", "checks", "platform", "site"],
    });
  });
});
