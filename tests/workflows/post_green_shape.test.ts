// GitHub's job-skip rules simulated over the parsed post-green graph, so a reworded condition is judged whatever its
// spelling: a condition with no status function implies success() over the WHOLE ancestry, and an unrun need is skipped
// with empty outputs. The push lane is a regression pin (#207), cross-file with the skeleton every fleet repository runs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { evaluateCondition, hasStatusFunction } from "../shared/github_expression.ts";

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

/** Simulates GitHub's own rules, which the body mirrors; `outputs` stands in for the step outputs
 * of every job that ran. "A failure or skip applies to all jobs in the dependency chain from the
 * point of failure or skip onwards", even through a job a status function let continue.
 *   an unrun need                       -> result `skipped`, empty outputs
 *   a condition with no status function -> implicit success() over the WHOLE ancestry
 *   the run's ref                       -> main's head unless given (ci.yml's push trigger is filtered to main)
 *   the PR head branch                  -> unset unless given, as on every event but pull_request */
function jobsRunning(
  jobs: Record<string, Job>,
  event: string,
  outputs: Record<string, string>,
  failed: string[] = [],
  ref = "refs/heads/main",
  headRef?: string,
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
    if (headRef !== undefined) context["github.head_ref"] = headRef;
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
    const statusFunction = condition !== "" && hasStatusFunction(condition);
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

  // #207: a ref-keyed group keeps one pending run and replaces it with the newest, so a burst of merges dropped the middle
  // commits' verdicts; every run that did run was green. Keyed by the commit, every push run completes; PR pushes keep
  // cancelling their stale runs. The skeleton every fleet repository runs carries the same block.
  test("ci.yml and the skeleton key a push run by its commit and never cancel it; only pull-request lanes cancel", () => {
    const skeleton = parseYaml(
      read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
    ) as { concurrency: Concurrency };
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
  //
  // Both hook calls gate on the plan's outputs: a seeded placeholder is never called (the billed minute the gate
  // saves), the release still cuts behind a skipped post-green, and a hook with jobs keeps its call. A skipped
  // placeholder's result vouches for nothing, so the release names `needs.all-green.result == 'success'` itself:
  // without it a red gate would release.
  test("the skeleton per event: all legs on a release push; the site alone on the schedule; the release gate on the release PR and a dispatch; a red hook skips the release only; a seeded hook skips its call; a red gate releases nothing", () => {
    const skeleton = parseYaml(
      read("files/base/.github/workflows/ci.yml").replaceAll("{{github_username}}", "owner"),
    ) as { jobs: Record<string, Job> };
    const every = Object.keys(skeleton.jobs).sort();
    const released = {
      "modules": '["release-please","site"]',
      "post-green": "true",
      "release-gate": "true",
      "release_created": "true",
      "prs_created": "true",
      "tag_name": "v1.2.3",
    };
    const seededHook = { ...released, "post-green": "false" };
    const seededGate = { ...released, "release-gate": "false" };
    const runs = (
      event: string,
      outputs: Record<string, string>,
      failed?: string[],
      ref?: string,
      headRef?: string,
    ) => jobsRunning(skeleton.jobs, event, outputs, failed, ref, headRef).sort();
    const MERGE_REF = "refs/pull/7/merge";
    const RELEASE_HEAD = "release-please--branches--main";
    expect({
      releasePush: runs("push", released),
      plainPush: runs("push", { ...released, modules: "[]" }),
      schedule: runs("schedule", released),
      dispatch: runs("workflow_dispatch", released),
      pullRequest: runs("pull_request", released, [], MERGE_REF, "feat/anything"),
      releasePullRequest: runs("pull_request", released, [], MERGE_REF, RELEASE_HEAD),
      redHook: runs("push", released, ["post-green"]),
      seededHookReleasePush: runs("push", seededHook),
      seededHookPlainPush: runs("push", { ...seededHook, modules: "[]" }),
      seededHookRedGate: runs("push", seededHook, ["all-green"]),
      seededGateDispatch: runs("workflow_dispatch", seededGate),
      seededGateReleasePullRequest: runs("pull_request", seededGate, [], MERGE_REF, RELEASE_HEAD),
    }).toEqual({
      releasePush: every.filter((job) => job !== "release-gate"),
      plainPush: ["all-green", "checks", "platform", "post-green"],
      schedule: ["all-green", "platform", "site"],
      dispatch: ["all-green", "checks", "platform", "release-gate", "site"],
      pullRequest: ["all-green", "checks", "platform"],
      releasePullRequest: ["all-green", "checks", "platform", "release-gate"],
      redHook: ["all-green", "checks", "platform", "site"],
      seededHookReleasePush: every.filter((job) => job !== "post-green" && job !== "release-gate"),
      seededHookPlainPush: ["all-green", "checks", "platform"],
      seededHookRedGate: ["checks", "platform"],
      seededGateDispatch: ["all-green", "checks", "platform", "site"],
      seededGateReleasePullRequest: ["all-green", "checks", "platform"],
    });
  });
});
