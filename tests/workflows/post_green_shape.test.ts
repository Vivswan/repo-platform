// GitHub's job-skip rules simulated over the parsed post-green graph, so a reworded condition is judged whatever its
// spelling: a condition with no status function implies success() over the WHOLE ancestry, and an unrun need is skipped
// with empty outputs. The push lane is a regression pin (#207), cross-file with the skeleton every fleet repository runs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { evaluateCondition, hasStatusFunction } from "../shared/github_expression.ts";
import { shippedSource } from "../shared/shipped_source.ts";

const root = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

interface Job {
  needs?: string[];
  if?: string;
}
interface Concurrency {
  group: string;
  "cancel-in-progress": string | boolean;
}

/** Every job `id` transitively needs. */
function ancestorsOf(jobs: Record<string, Job>, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(jobs[id].needs ?? [])];
  for (let need = stack.pop(); need !== undefined; need = stack.pop()) {
    if (seen.has(need)) continue;
    seen.add(need);
    stack.push(...(jobs[need].needs ?? []));
  }
  return seen;
}

/** A need's `result` as the dependent reads it: `skipped` for one that did not run and was not failed. */
function needResult(need: string, ran: Set<string>, failed: string[]): string {
  if (ran.has(need)) return "success";

  if (failed.includes(need)) return "failure";

  return "skipped";
}

/** What a job's condition reads of its needs: each one's `result`, and each output of the run as the need wrote it, or
 *  '' for a need that did not run. */
function needsContext(
  needs: string[],
  ran: Set<string>,
  failed: string[],
  outputs: Record<string, string>,
): Record<string, string> {
  const context: Record<string, string> = {};
  for (const need of needs) {
    context[`needs.${need}.result`] = needResult(need, ran, failed);
    for (const [name, value] of Object.entries(outputs)) {
      context[`needs.${need}.outputs.${name}`] = ran.has(need) ? value : "";
    }
  }
  return context;
}

/** What a simulated run may vary beyond its event and outputs. */
interface Scenario {
  failed?: string[];
  ref?: string;
  headRef?: string;
  isPrivate?: boolean;
  isFork?: boolean;
}

/** Simulates GitHub's own rules, which the body mirrors; `outputs` stands in for the step outputs
 * of every job that ran. "A failure or skip applies to all jobs in the dependency chain from the
 * point of failure or skip onwards", even through a job a status function let continue.
 *   an unrun need                       -> result `skipped`, empty outputs
 *   a condition with no status function -> implicit success() over the WHOLE ancestry
 *   the run's ref                       -> main's head unless given (ci.yml's push trigger is filtered to main)
 *   the PR head branch                  -> unset unless given, as on every event but pull_request
 *   the repository's visibility         -> public, and no fork, unless given */
function jobsRunning(
  jobs: Record<string, Job>,
  event: string,
  outputs: Record<string, string>,
  {
    failed = [],
    ref = "refs/heads/main",
    headRef,
    isPrivate = false,
    isFork = false,
  }: Scenario = {},
): string[] {
  const ran = new Set<string>();
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
    const context: Record<string, string | boolean> = {
      "github.event_name": event,
      "github.ref": ref,
      "github.event.repository.private": isPrivate,
      "github.event.repository.fork": isFork,
      ...needsContext(needs, ran, failed, outputs),
    };
    if (headRef !== undefined) context["github.head_ref"] = headRef;
    const condition = job.if ?? "";
    const statusFunction = condition !== "" && hasStatusFunction(condition);
    const chainRan = [...ancestorsOf(jobs, id)].every((need) => ran.has(need));
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
    expect(
      jobsRunning(jobs, "push", { armed: "true" }, { failed: ["move-stable"] }).sort(),
    ).toEqual(["read-directives", "settings-fleet"]);
  });

  // #207: a ref-keyed group keeps one pending run and replaces it with the newest, so a burst of merges dropped the middle
  // commits' verdicts; every run that did run was green. Keyed by the commit, every push run completes; PR pushes keep
  // cancelling their stale runs. The skeleton every fleet repository runs carries the same block.
  test("ci.yml and the skeleton key a push run by its commit and never cancel it; only pull-request lanes cancel", () => {
    const skeleton = parseYaml(shippedSource("files/base/.github/workflows/ci.yml")) as {
      concurrency: Concurrency;
    };
    for (const doc of [ci, skeleton]) {
      expect(doc.concurrency).toEqual({
        group:
          "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
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
  // The release gate's condition reads github.head_ref, which GitHub sets on pull_request alone; a spelling that read the
  // ref or the event only would run the gate on every PR or on none.
  // A private repository's nightly runs no job at all (a skipped job bills nothing), and its other events run as a
  // public repository's do; a clause on `platform` alone would leave the gate running and red every night.
  test("the skeleton: every leg runs on a release commit's push; the schedule rebuilds the site alone, and nothing when private; a red hook skips the release and the deploy still runs; the release gate runs on the release PR and a dispatch alone", () => {
    const skeleton = parseYaml(shippedSource("files/base/.github/workflows/ci.yml")) as {
      jobs: Record<string, Job>;
    };
    const every = Object.keys(skeleton.jobs).sort();
    const released = {
      modules: '["release-please","npm","site"]',
      release_created: "true",
      prs_created: "true",
      tag_name: "v1.2.3",
    };
    const runs = (event: string, outputs: Record<string, string>, scenario?: Scenario) =>
      jobsRunning(skeleton.jobs, event, outputs, scenario).sort();
    const MERGE_REF = "refs/pull/7/merge";
    expect({
      releasePush: runs("push", released),
      plainPush: runs("push", { modules: "[]" }),
      schedule: runs("schedule", released),
      privateSchedule: runs("schedule", released, { isPrivate: true }),
      privatePush: runs("push", { modules: "[]" }, { isPrivate: true }),
      dispatch: runs("workflow_dispatch", released),
      pullRequest: runs("pull_request", released, { ref: MERGE_REF, headRef: "feat/anything" }),
      releasePullRequest: runs("pull_request", released, {
        ref: MERGE_REF,
        headRef: "release-please--branches--main",
      }),
      redHook: runs("push", released, { failed: ["post-green"] }),
      redPublish: runs("push", released, { failed: ["publish-release"] }),
    }).toEqual({
      releasePush: every.filter((job) => job !== "release-gate"),
      plainPush: ["all-green", "checks", "platform", "post-green"],
      schedule: ["all-green", "platform", "site"],
      privateSchedule: [],
      privatePush: ["all-green", "checks", "platform", "post-green"],
      dispatch: ["all-green", "checks", "platform", "release-gate", "site"],
      pullRequest: ["all-green", "checks", "platform"],
      releasePullRequest: ["all-green", "checks", "platform", "release-gate"],
      redHook: ["all-green", "checks", "platform", "site"],
      redPublish: every.filter((job) => job !== "release-gate" && job !== "publish-release"),
    });
  });

  // The npm legs gate on the same skip rules. A condition on publish-release reading `success` alone would leave every
  // release of a repository without the npm module a draft, green; one without the prs_created clause would publish
  // `next` on every merge. A fork carries the registration and none of npm's trust, so its legs would fail on every push.
  test("the skeleton's npm legs: next publishes on the push that refreshes the release PR alone; a red release publish holds the GitHub release a draft, and a repository without the module still publishes it; a fork publishes nothing to npm", () => {
    const skeleton = parseYaml(shippedSource("files/base/.github/workflows/ci.yml")) as {
      jobs: Record<string, Job>;
    };
    const cut = {
      modules: '["release-please","npm"]',
      release_created: "true",
      prs_created: "false",
      tag_name: "v1.2.3",
    };
    const refresh = { ...cut, release_created: "false", prs_created: "true" };
    const legs = (outputs: Record<string, string>, scenario?: Scenario) =>
      jobsRunning(skeleton.jobs, "push", outputs, scenario)
        .filter((job) => /^(npm-|publish-release$)/.test(job))
        .sort();
    expect({
      releasePush: legs(cut),
      refreshPush: legs(refresh),
      quietPush: legs({ ...refresh, prs_created: "false" }),
      releaseWithoutNpm: legs({ ...cut, modules: '["release-please"]' }),
      refreshWithoutNpm: legs({ ...refresh, modules: '["release-please"]' }),
      redNpmLatest: legs(cut, { failed: ["npm-latest"] }),
      forkReleasePush: legs(cut, { isFork: true }),
      forkRefreshPush: legs(refresh, { isFork: true }),
    }).toEqual({
      releasePush: ["npm-latest", "publish-release"],
      refreshPush: ["npm-next"],
      quietPush: [],
      releaseWithoutNpm: ["publish-release"],
      refreshWithoutNpm: [],
      redNpmLatest: [],
      forkReleasePush: ["publish-release"],
      forkRefreshPush: [],
    });
  });

  // GitHub fails a job whose condition errors, and fromJSON errors on the empty text an unrun job's output reads as.
  // Every other clause holds here, so the leg's own guard is what keeps a skipped platform a skip and not a red run.
  test("the skeleton: a leg selected by module stands down, without an error, when platform published no modules", () => {
    const skeleton = parseYaml(
      read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
    ) as { jobs: Record<string, Job> };
    const verdicts = Object.entries(skeleton.jobs)
      .filter(([, job]) => job.if?.includes("needs.platform.outputs.modules"))
      .map(([id, job]) => {
        const others = (job.needs ?? []).filter((need) => need !== "platform");
        const ran = new Set(others);
        const context = {
          "github.event_name": "push",
          "github.ref": "refs/heads/main",
          "github.event.repository.fork": false,
          ...needsContext(others, ran, [], { release_created: "true", prs_created: "true" }),
          "needs.platform.result": "skipped",
        };
        return [id, evaluateCondition(job.if ?? "", context)];
      });

    expect(Object.fromEntries(verdicts)).toEqual({
      "release": false,
      "npm-latest": false,
      "npm-next": false,
      "site": false,
    });
  });
});
