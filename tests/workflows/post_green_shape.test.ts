// GitHub's job-skip rules simulated over the parsed post-green graph, so a reworded condition is judged whatever its
// spelling: a condition with no status function implies success() over the WHOLE ancestry, and an unrun need is skipped
// with empty outputs. The push lane is a regression pin (#207), cross-file with the skeleton every fleet repository runs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

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

/** A missing context read is the empty string, as an unrun job's output is in Actions. */
function evaluateCondition(expression: string, context: Record<string, string>): boolean {
  const tokens = expression.match(/'[^']*'|[A-Za-z_][\w.-]*(?:\(\))?|==|!=|&&|\|\||[()!]/g) ?? [];
  if (tokens.join("").replace(/\s/g, "") !== expression.replace(/\s/g, "")) {
    throw new Error(`unsupported expression: ${expression}`);
  }
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const value = (): string | boolean => {
    const token = next();
    if (token === undefined) throw new Error(`unexpected end of ${expression}`);
    if (token === "!") return !value();
    if (token === "(") {
      const inner = or();
      if (next() !== ")") throw new Error(`unbalanced parentheses in ${expression}`);
      return inner;
    }
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === "cancelled()") return false;
    return context[token] ?? "";
  };
  const comparison = (): string | boolean => {
    const left = value();
    if (peek() === "==" || peek() === "!=") {
      const op = next();
      const right = value();
      return op === "==" ? left === right : left !== right;
    }
    return left;
  };
  const and = (): boolean => {
    let result = Boolean(comparison());
    while (peek() === "&&") {
      next();
      result = Boolean(comparison()) && result;
    }
    return result;
  };
  const or = (): boolean => {
    let result = and();
    while (peek() === "||") {
      next();
      result = and() || result;
    }
    return result;
  };
  const result = or();
  if (at !== tokens.length) throw new Error(`trailing tokens in ${expression}`);
  return result;
}

/** Simulates GitHub's own rules, which the body mirrors; `outputs` stands in for the step outputs
 * of every job that ran. "A failure or skip applies to all jobs in the dependency chain from the
 * point of failure or skip onwards", even through a job a status function let continue.
 *   an unrun need                       -> result `skipped`, empty outputs
 *   a condition with no status function -> implicit success() over the WHOLE ancestry */
function jobsRunning(
  jobs: Record<string, Job>,
  event: string,
  outputs: Record<string, string>,
  failed: string[] = [],
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
    const context: Record<string, string> = { "github.event_name": event };
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
    expect(jobs["read-directives"].if).not.toContain("needs.move-stable.outputs");
    // A red mover (a lost lease, a refused push) leaves the read on the push's own before and skips the
    // sync (the tag names a stale commit), nothing else.
    expect(jobsRunning(jobs, "push", { armed: "true" }, ["move-stable"]).sort()).toEqual([
      "read-directives",
      "settings-fleet",
    ]);
  });

  // The condition is evaluated, not searched for: a clause moved into a comment reads the same to a text search and
  // releases the fleet's post-green legs on a pull request or a red gate.
  test("ci.yml's post-green job runs on a green gate on a push to main and on nothing else", () => {
    const condition = ci.jobs["post-green"].if ?? "";
    const runsWhen = (context: Record<string, string>) =>
      evaluateCondition(condition, {
        "needs.all-green.result": "success",
        "github.event_name": "push",
        "github.ref": "refs/heads/main",
        ...context,
      });
    expect({
      greenPushToMain: runsWhen({}),
      redGate: runsWhen({ "needs.all-green.result": "failure" }),
      skippedGate: runsWhen({ "needs.all-green.result": "skipped" }),
      pullRequest: runsWhen({
        "github.event_name": "pull_request",
        "github.ref": "refs/pull/1/merge",
      }),
      dispatch: runsWhen({ "github.event_name": "workflow_dispatch" }),
      schedule: runsWhen({ "github.event_name": "schedule" }),
      pushToBranch: runsWhen({ "github.ref": "refs/heads/topic" }),
    }).toEqual({
      greenPushToMain: true,
      redGate: false,
      skippedGate: false,
      pullRequest: false,
      dispatch: false,
      schedule: false,
      pushToBranch: false,
    });
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
});
