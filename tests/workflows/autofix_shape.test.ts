// The autofix workflows' conditions, read as the runner reads them. What would drift silently: a condition that lets
// the fix jobs start for a fork or under pull_request_target runs pull request code where it must never run, and one
// that compares an unrun job's absent output loosely pushes, comments, or stands down on nothing. Each is green in
// this repository's own CI, which never labels a fork's pull request.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseEvent } from "../../actions/autofix/autofix";
import { REPO_ROOT } from "../shared/action_step";
import {
  contextReads,
  evaluateCondition,
  expressionsIn,
  hasStatusFunction,
  interpolate,
  parseExpression,
} from "../shared/github_expression";

interface Step {
  id?: string;
  uses?: string;
  if?: string;
  with?: Record<string, string>;
}
interface Job {
  needs?: string[];
  if?: string;
  steps?: Step[];
}
interface Workflow {
  concurrency: { group: string };
  jobs: Record<string, Job>;
}

type Context = Record<string, string | boolean>;

const load = (rel: string) =>
  parseYaml(
    readFileSync(join(REPO_ROOT, rel), "utf8").replaceAll("{{github_username}}", "owner"),
  ) as Workflow;
const caller = load("files/autofix/.github/workflows/auto-fix.yml");
const called = load(".github/workflows/fleet-autofix.yml");

const stickyStep = (job: Job) =>
  (job.steps ?? []).find((step) => step.uses?.startsWith("marocchino/") === true);
const NO_NOTICE_LINE = interpolate(stickyStep(called.jobs.push)?.with?.message ?? "", {
  "steps.push.outputs.notice": "",
});

const REPOSITORY = "example/widget";

/** A pull request event's context; a head repository of null is a fork that was deleted. */
function event(
  name: string,
  action: string,
  { head = REPOSITORY, label }: { head?: string | null; label?: string } = {},
): Context {
  const context: Context = {
    "github.event_name": name,
    "github.event.action": action,
    "github.event.pull_request.number": "7",
    "github.repository": REPOSITORY,
  };
  if (head !== null) context["github.event.pull_request.head.repo.full_name"] = head;
  if (label !== undefined) context["github.event.label.name"] = label;
  return context;
}

const FORK = { head: "stranger/widget" };

function outcome(runs: boolean, failed: boolean): string {
  if (!runs) return "skipped";

  return failed ? "failure" : "success";
}

/**
 * The steps that run, by GitHub's rule: once a step failed, only a condition with a status function still runs.
 * Each step's outcome is written into `context` for the steps after it; `fails` is the id of the step that fails.
 */
function stepsRunning(steps: Step[], context: Context, fails: string | undefined): Step[] {
  const ran: Step[] = [];
  let broke = false;
  for (const step of steps) {
    const condition = step.if ?? "";
    const holds = condition === "" || evaluateCondition(condition, context);
    const runs = holds && (!broke || hasStatusFunction(condition));
    const failed = runs && step.id !== undefined && step.id === fails;
    if (runs) ran.push(step);
    if (failed) broke = true;
    if (step.id !== undefined) context[`steps.${step.id}.outcome`] = outcome(runs, failed);
  }

  return ran;
}

describe("the managed auto-fix.yml", () => {
  test.each<{ reason: string; context: Context; calls: boolean }>([
    {
      reason: "the fix-lint label on a same-repository pull request",
      context: event("pull_request", "labeled", { label: "fix-lint" }),
      calls: true,
    },
    {
      reason: "another label",
      context: event("pull_request", "labeled", { label: "bug" }),
      calls: false,
    },
    ...["opened", "synchronize", "reopened"].map((action) => ({
      reason: `a same-repository pull request ${action}`,
      context: event("pull_request", action),
      calls: true,
    })),
    {
      reason: "a fork's push, whose run holds a read-only token",
      context: event("pull_request", "synchronize", FORK),
      calls: false,
    },
    {
      reason: "a fork's label under pull_request",
      context: event("pull_request", "labeled", { ...FORK, label: "fix-lint" }),
      calls: false,
    },
    {
      reason: "a fork's label under pull_request_target, for the removal",
      context: event("pull_request_target", "labeled", { ...FORK, label: "fix-lint" }),
      calls: true,
    },
    {
      reason: "a deleted fork's label under pull_request_target",
      context: event("pull_request_target", "labeled", { head: null, label: "fix-lint" }),
      calls: true,
    },
    {
      reason: "a deleted fork's push",
      context: event("pull_request", "synchronize", { head: null }),
      calls: false,
    },
    {
      reason:
        "a same-repository label under pull_request_target, which the pull_request run already answers",
      context: event("pull_request_target", "labeled", { label: "fix-lint" }),
      calls: false,
    },
    {
      reason: "a fork's other label under pull_request_target",
      context: event("pull_request_target", "labeled", { ...FORK, label: "bug" }),
      calls: false,
    },
  ])("calls the fleet workflow or stands down: $reason", ({ context, calls }) => {
    expect(evaluateCondition(caller.jobs.autofix.if ?? "", context)).toBe(calls);
  });

  // cancel-in-progress is on, and a same-repository label starts a pull_request run and a pull_request_target run at
  // once. In one lane the second, which calls nothing, would cancel the fix. GitHub compares lane names without case,
  // and anyone who may label can add a label named `push`, whose lane must not be the push's.
  test("the label's fix, the same label's pull_request_target run, a push, and another label, even one named push, each hold their own lane; two pushes share one", () => {
    const lane = (context: Context) => interpolate(caller.concurrency.group, context).toLowerCase();
    const lanes = [
      lane(event("pull_request", "labeled", { label: "fix-lint" })),
      lane(event("pull_request_target", "labeled", { label: "fix-lint" })),
      lane(event("pull_request", "synchronize")),
      lane(event("pull_request", "labeled", { label: "bug" })),
      lane(event("pull_request", "labeled", { label: "PUSH" })),
    ];
    expect({
      distinct: new Set(lanes).size,
      pushesShare: lane(event("pull_request", "opened")) === lanes[2],
    }).toEqual({ distinct: lanes.length, pushesShare: true });
  });
});

describe("the called fleet-autofix.yml", () => {
  /** A job's condition over the event (`name/action`), the plan's output, and each needed job's result. */
  function holds(job: Job, on: string, run: string | null, results: Context): boolean {
    const [eventName, action] = on.split("/");
    const context: Context = {
      "github.event_name": eventName,
      "github.event.action": action,
      ...results,
    };
    if (run !== null) context["needs.plan.outputs.run"] = run;
    return job.if === undefined || evaluateCondition(job.if, context);
  }

  /** The jobs that run, by GitHub's rule: a condition with no status function also needs every needed job to have succeeded. */
  function jobsRunning(
    on: string,
    run: string | null,
    failed: Record<string, string> = {},
  ): string[] {
    const ran: string[] = [];
    const result = (need: string) => failed[need] ?? (ran.includes(need) ? "success" : "skipped");
    for (const [id, job] of Object.entries(called.jobs)) {
      const needs = job.needs ?? [];
      const results = Object.fromEntries(
        needs.map((need) => [`needs.${need}.result`, result(need)]),
      );
      const chainRan = needs.every((need) => result(need) === "success");
      if (!holds(job, on, run, results)) continue;
      if (hasStatusFunction(job.if ?? "") || chainRan) ran.push(id);
    }
    return ran;
  }

  const PUSH = "pull_request/synchronize";
  const LABEL = "pull_request/labeled";
  const TARGET = "pull_request_target/labeled";

  test.each<{
    reason: string;
    on: string;
    run: string | null;
    results?: Record<string, string>;
    jobs: string[];
  }>([
    { reason: "a planned fix", on: PUSH, run: "true", jobs: ["plan", "stage", "push"] },
    { reason: "a plan that stands down", on: PUSH, run: "false", jobs: ["plan"] },
    {
      reason: "the label where the module is not selected, which reaches the label's removal alone",
      on: LABEL,
      run: "false",
      jobs: ["plan", "push"],
    },
    { reason: "a plan that set no output", on: LABEL, run: null, jobs: ["plan"] },
    { reason: "a plan whose output is empty", on: LABEL, run: "", jobs: ["plan"] },
    {
      reason: "a failed plan on a push",
      on: PUSH,
      run: null,
      results: { plan: "failure" },
      jobs: ["plan"],
    },
    {
      reason: "a failed plan on the label, which still reaches the label's removal",
      on: LABEL,
      run: null,
      results: { plan: "failure" },
      jobs: ["plan", "push"],
    },
    {
      reason: "a failed hook, which still reaches the label's removal",
      on: LABEL,
      run: "true",
      results: { stage: "failure" },
      jobs: ["plan", "stage", "push"],
    },
    { reason: "a fork's label", on: TARGET, run: null, jobs: ["fork"] },
    {
      reason: "pull_request_target with a forged plan output, where no fix job may start",
      on: TARGET,
      run: "true",
      jobs: ["fork"],
    },
  ])("the jobs that run: $reason", ({ on, run, results, jobs }) => {
    expect(jobsRunning(on, run, results)).toEqual(jobs);
  });

  // The push job runs after a failed stage, for the label's removal alone, and its notice step speaks for a run that
  // died. A step there that tested the stage's result, the report's subject, or the notice loosely would apply, ask
  // the gate, or comment with nothing staged. And a refusal left on the pull request by an earlier run, or one lane's
  // notice written over the other's, would tell the reader something no longer true.
  test.each<{
    reason: string;
    stage: string;
    outputs?: Record<string, string>;
    fails?: string;
    action: string;
    ran: { fix: boolean; gate: boolean; unlabel: boolean };
    told: string | null;
  }>([
    {
      reason: "a staged fix with a subject and something to say, on the label",
      stage: "success",
      outputs: {
        "steps.report.outputs.subject": "style: format",
        "steps.push.outputs.notice": "Pushed.",
      },
      action: "labeled",
      ran: { fix: true, gate: true, unlabel: true },
      told: "repo-platform/autofix-label: Pushed.",
    },
    {
      reason:
        "a push with no subject and nothing to say, which clears what an earlier push run said",
      stage: "success",
      outputs: { "steps.report.outputs.subject": "", "steps.push.outputs.notice": "" },
      action: "synchronize",
      ran: { fix: true, gate: false, unlabel: false },
      told: "repo-platform/autofix-push: deleted",
    },
    {
      reason: "a push whose fix was refused, in the push lane's own comment",
      stage: "success",
      outputs: { "steps.report.outputs.subject": "", "steps.push.outputs.notice": "Refused." },
      fails: "push",
      action: "synchronize",
      ran: { fix: true, gate: false, unlabel: false },
      told: "repo-platform/autofix-push: Refused.",
    },
    {
      reason: "a report that cannot be read, which ends the run before the push step",
      stage: "success",
      fails: "report",
      action: "labeled",
      ran: { fix: false, gate: false, unlabel: true },
      told: "repo-platform/autofix-label: the fixed line",
    },
    {
      reason: "a push step that died before it worded a notice",
      stage: "success",
      outputs: { "steps.report.outputs.subject": "" },
      fails: "push",
      action: "opened",
      ran: { fix: true, gate: false, unlabel: false },
      told: "repo-platform/autofix-push: the fixed line",
    },
    {
      reason: "a failed hook on the label",
      stage: "failure",
      action: "labeled",
      ran: { fix: false, gate: false, unlabel: true },
      told: null,
    },
    {
      reason: "a failed hook on a push",
      stage: "failure",
      action: "opened",
      ran: { fix: false, gate: false, unlabel: false },
      told: null,
    },
    {
      reason: "a failed plan on the label, with no stage at all",
      stage: "skipped",
      action: "labeled",
      ran: { fix: false, gate: false, unlabel: true },
      told: null,
    },
    {
      reason: "a cancelled stage",
      stage: "cancelled",
      action: "synchronize",
      ran: { fix: false, gate: false, unlabel: false },
      told: null,
    },
  ])("the push job's steps: $reason", ({ stage, outputs = {}, fails, action, ran, told }) => {
    const context: Context = {
      "needs.stage.result": stage,
      "github.event.action": action,
      ...outputs,
    };
    const steps = stepsRunning(called.jobs.push.steps ?? [], context, fails);
    const phase = (name: string) => steps.some((step) => step.with?.phase === name);
    const sticky = steps.find((step) => step === stickyStep(called.jobs.push));
    const say = (key: string) => interpolate(sticky?.with?.[key] ?? "", context);
    const message = say("message") === NO_NOTICE_LINE ? "the fixed line" : say("message");
    expect({
      ran: {
        fix: phase("push"),
        gate: steps.some((step) => step.uses === "$/actions/validate-commit-names"),
        unlabel: phase("unlabel"),
      },
      told:
        sticky === undefined
          ? null
          : `${say("header")}: ${say("delete") === "true" ? "deleted" : message}`,
    }).toEqual({ ran, told });
  });

  // The comment is posted with the write token, and its message is not quoted by anything: a message that read the
  // pull request's title or branch name would post the pull request's own Markdown. The one value it may read is
  // the notice worded by the step that runs the push phase, whatever that step's id, and its stand-in is fixed text.
  test("the notice step's message reads the push phase's notice alone, and its stand-in is fixed text", () => {
    const push = (called.jobs.push.steps ?? []).find((step) => step.with?.phase === "push");
    const expressions = expressionsIn(stickyStep(called.jobs.push)?.with?.message ?? "");
    expect({
      reads: expressions.flatMap((source) => contextReads(parseExpression(source).tree)),
      standIn: { said: NO_NOTICE_LINE !== "", expression: NO_NOTICE_LINE.includes("${{") },
    }).toEqual({
      reads: [["steps", push?.id ?? "no step runs the push phase", "outputs", "notice"]],
      standIn: { said: true, expression: false },
    });
  });

  // A fork is told through the label lane's comment: the label is what it answers, and a second comment for it
  // would never be replaced. A job with no sticky step, or a step with no header, reads here as absent, never as equal.
  test("the fork job's note and a label run's notice are one comment", () => {
    const header = (job: Job) =>
      interpolate(stickyStep(job)?.with?.header ?? "", { "github.event.action": "labeled" });
    const headers = { fork: header(called.jobs.fork), push: header(called.jobs.push) };
    expect({ present: Object.values(headers).every((name) => name !== ""), headers }).toEqual({
      present: true,
      headers: { fork: headers.push, push: headers.fork },
    });
  });

  // The gate's step runs under continue-on-error, and a skipped or failed one must read as "not accepted": a loose
  // test would commit under a subject the gate never saw.
  test.each([
    ["success", "true"],
    ["failure", "false"],
    ["skipped", "false"],
    [null, "false"],
  ])("a gate step that ended %p hands the push subject-accepted %p", (outcome, accepted) => {
    const push = (called.jobs.push.steps ?? []).find((step) => step.with?.phase === "push");
    const context: Context = { "steps.report.outputs.subject": "" };
    if (outcome !== null) context["steps.subject.outcome"] = outcome;
    expect(interpolate(push?.with?.["subject-accepted"] ?? "", context)).toBe(accepted);
  });

  // The hook's `event` input and the action's own reading of the payload must name one trigger, or the hook runs the
  // formatter while the lists judged are the generator's. An expression compares the label without case, so a label
  // the caller lets through in another case must read as the label here too, never throw with the label left on.
  test.each([
    ["labeled", "fix-lint"],
    ["labeled", "Fix-Lint"],
    ["labeled", "FIX-LINT"],
    ["opened", undefined],
    ["synchronize", undefined],
    ["reopened", undefined],
  ])(
    "on %p (label %p) the caller starts the fix and the hook is told the trigger the action reads from the payload",
    (action, label) => {
      const hook = (called.jobs.stage.steps ?? []).find(
        (step) => step.uses === "./.github/actions/autofix",
      );
      const payload = {
        action,
        label: label === undefined ? undefined : { name: label },
        pull_request: {
          number: 7,
          head: { sha: "a".repeat(40), ref: "topic" },
          user: { login: "octocat" },
        },
      };
      expect({
        called: evaluateCondition(
          caller.jobs.autofix.if ?? "",
          event("pull_request", action, { label }),
        ),
        hook: interpolate(hook?.with?.event ?? "", { "github.event.action": action }),
      }).toEqual({ called: true, hook: parseEvent(JSON.stringify(payload)).kind });
    },
  );
});
