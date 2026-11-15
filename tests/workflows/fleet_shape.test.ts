// fleet.yml is the fleet's gate-job home, every job of the skeleton's one `platform` call. Pinned here is what a green
// run cannot show: GitHub's step rule (a bare step implies success()), the schedule census (the `platform` caller
// runs every night in a public repository, so a step without a schedule clause runs nightly across them), the output
// chain GitHub resolves to '' without an error, and two gates whose wrong spelling stays green.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Expr, FunctionCall, Literal, Logical } from "@actions/expressions/ast";
import { TokenType } from "@actions/expressions/lexer";
import { parse as parseYaml } from "yaml";
import { RELEASE_BRANCH_PREFIX } from "../../actions/shared/platform.ts";
import {
  conditionSource,
  contextRead,
  evaluateCondition,
  hasStatusFunction,
  parseExpression,
  printed,
  readsIn,
  soleRead,
  subexpressions,
} from "../shared/github_expression.ts";
import { shippedSource } from "../shared/shipped_source.ts";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string | boolean>;
  "continue-on-error"?: boolean;
}
interface Job {
  if?: string;
  needs?: string[];
  uses?: string;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: { workflow_call: { outputs: Record<string, { value: string }> } };
  jobs: Record<string, Job>;
}

const ROOT = join(import.meta.dir, "../..");
const WORKFLOWS = ".github/workflows";
const loadWorkflow = (name: string) =>
  parseYaml(readFileSync(join(ROOT, WORKFLOWS, name), "utf8")) as Workflow;
const fleet = loadWorkflow("fleet.yml");
const CHECKS_JOB = "standard-checks";
const checksJob = fleet.jobs[CHECKS_JOB];
const checkSteps = checksJob?.steps ?? [];
const label = (step: Step) => step.id ?? step.name ?? step.uses ?? "";
const PLATFORM_ACTION_PREFIX = "$/actions/";

/** The action a `uses:` names by its `$/` path, or undefined for any other reference. */
function platformAction(uses: string | undefined): string | undefined {
  return uses?.startsWith(PLATFORM_ACTION_PREFIX)
    ? uses.slice(PLATFORM_ACTION_PREFIX.length)
    : undefined;
}

/** The top-level conjuncts of a condition as GitHub's own parser reads them, each in the parser's one spelling: an
 *  `&&` inside a string literal or a parenthesis splits nothing, and spacing decides nothing. A condition that is not
 *  an `&&` chain is one clause. */
function clausesOf(condition: string | undefined): string[] {
  if (condition === undefined) return [""];

  const { tree } = parseExpression(conditionSource(condition));
  const chain = tree instanceof Logical && tree.operator.type === TokenType.AND;
  return (chain ? tree.args : [tree]).map(printed);
}

/** Every literal prefix a `startsWith(github.head_ref, ...)` call anywhere in the expression tests. */
function headRefPrefixes(expr: Expr): string[] {
  if (expr instanceof FunctionCall) {
    const [subject, prefix] = expr.args;
    const testsHeadRef =
      expr.functionName.lexeme.toLowerCase() === "startswith" &&
      contextRead(subject)?.join(".") === "github.head_ref";
    if (testsHeadRef && prefix instanceof Literal) return [prefix.literal.coerceString()];
  }

  return subexpressions(expr).flatMap(headRefPrefixes);
}

/** The head-ref prefixes a condition tests, read by GitHub's own parser so spacing, quoting, and bracket access read
 *  as GitHub reads them. */
function prefixesOf(condition: string | undefined): string[] {
  return headRefPrefixes(parseExpression(conditionSource(condition ?? "")).tree);
}

/** The `<id>` and `<name>` of a value that is one `<context>.<id>.outputs.<name>` read whole, or neither. */
function wiredTo(value: string, context: string): [string, string] | [] {
  const [from, id, field, name, ...deeper] = soleRead(value) ?? [];
  const wired = from === context && field === "outputs" && deeper.length === 0;
  return wired && typeof id === "string" && typeof name === "string" ? [id, name] : [];
}

/** Every `needs.<job>.outputs.<name>` and `steps.<id>.outputs.<name>` a node reads, as `[context, from, name]`. */
function outputReads(node: unknown): [string, string, string][] {
  return readsIn(node).flatMap(([context, from, field, name]) =>
    (context === "needs" || context === "steps") && field === "outputs" && from && name
      ? [[context, from, name] as [string, string, string]]
      : [],
  );
}

describe("fleet.yml", () => {
  // A step or job whose condition is not !cancelled() or always() is skipped by an earlier failure (a bare one implies
  // success(), and so does a `&& success()` appended anywhere), so one red check would hide every later check and every job
  // that needs it; continue-on-error fails open instead. The checkout and the plan are the bare steps:
  // nothing after a failed plan may run, and the plan's own red names it.
  const independence = (condition: string | undefined) => {
    const [first, ...rest] = clausesOf(condition);
    return { first, laterStatusFunctions: rest.filter(hasStatusFunction) };
  };
  const INDEPENDENT = { first: "!cancelled()", laterStatusFunctions: [] };
  const BARE_STEPS = ["checkout", "plan"];

  test("a failing check still runs every later check and every job that needs it; none fails open", () => {
    const bare = checkSteps.slice(0, BARE_STEPS.length);
    const checks = checkSteps.slice(BARE_STEPS.length);
    expect(checks.length).toBeGreaterThan(5);
    expect(bare.map((step) => [step.id, step.if, step["continue-on-error"]])).toEqual(
      BARE_STEPS.map((id) => [id, undefined, undefined]),
    );
    expect(
      checks.map((step) => ({
        step: label(step),
        ...independence(step.if),
        "continue-on-error": step["continue-on-error"],
      })),
    ).toEqual(
      checks.map((step) => ({ step: label(step), ...INDEPENDENT, "continue-on-error": undefined })),
    );
    const dependent = Object.entries(fleet.jobs).filter(([, job]) => job.needs !== undefined);
    expect(dependent.length).toBeGreaterThan(3);
    expect(dependent.map(([name, job]) => ({ job: name, ...independence(job.if) }))).toEqual(
      dependent.map(([name]) => ({ job: name, ...INDEPENDENT })),
    );
  });

  // The merge ref GitHub checks out by default already contains main's tip, so the freshness check would pass for every
  // PR, stale ones included; only the PR head makes it a check. release-health's pull-request mode runs it first.
  test("release-pr checks out the PR head, never the merge ref, before release-health", () => {
    const steps = fleet.jobs["release-pr"]?.steps ?? [];
    const health = steps.findIndex((step) => platformAction(step.uses) === "release-health");
    expect(health).toBeGreaterThan(0);
    expect(steps[health]?.with?.mode).toBe("pull-request");
    const checkouts = steps
      .slice(0, health)
      .filter((step) => /^actions\/checkout@/.test(step.uses ?? "") && !step.with?.repository);
    expect(checkouts.map((step) => step.with?.ref)).toStrictEqual([
      "${{ github.event.pull_request.head.sha }}",
    ]);
  });

  // Freshness no longer fails the job, so a stale release PR is green unless the heal runs; GitHub resolves a gate on a
  // literal other than the 'true' freshness.ts writes (tests/actions/release-health/freshness.test.ts pins those bytes)
  // to false with no error, and a bare step implies success(), so without !cancelled() a red health gate would leave the
  // PR stale (Copilot's finding on #493). Nothing but the first stale release PR in a fleet repository would show a wrong
  // gate, a verdict before the propose whose head it reads or after a failed one (it would merge main instead), a propose
  // that also tries a release off this PR event (skip-github-release), or a missing write grant (release-please's 403),
  // weeks later and in another repository. One sha per action across the workflows is tests/workflows/delivery_pins.test.ts's.
  test("a stale release PR heals whatever the gates said: propose, then the verdict after a successful propose, under the push grants", () => {
    const job = fleet.jobs["release-pr"] as
      | (Job & { permissions?: Record<string, string> })
      | undefined;
    const steps = job?.steps ?? [];
    const healthAt = steps.findIndex((step) => platformAction(step.uses) === "release-health");
    const health = steps[healthAt];
    const propose = steps.findIndex((step) =>
      (step.uses ?? "").startsWith("googleapis/release-please-action@"),
    );
    const verdict = steps.findIndex((step) => step.with?.mode === "after-refresh");
    const BEHIND = `steps.${health?.id}.outputs.behind == 'true'`;
    expect({
      propose: { if: clausesOf(steps[propose]?.if), with: steps[propose]?.with },
      verdict: {
        action: platformAction(steps[verdict]?.uses),
        if: clausesOf(steps[verdict]?.if),
        afterPropose: healthAt >= 0 && healthAt < propose && propose < verdict,
      },
      permissions: job?.permissions,
    }).toEqual({
      propose: {
        if: ["!cancelled()", BEHIND],
        with: { token: "${{ github.token }}", "skip-github-release": true },
      },
      verdict: {
        action: "release-health",
        if: ["!cancelled()", BEHIND, `steps.${steps[propose]?.id}.outcome == 'success'`],
        afterPropose: true,
      },
      permissions: {
        contents: "write",
        issues: "read",
        "pull-requests": "write",
        "vulnerability-alerts": "read",
      },
    });
  });

  // Which steps and jobs a scheduled run may reach: the checkout, the plan, and CodeQL on its weekly day. Every other
  // step and job excludes the schedule or gates on one that does, so a new step or job must take a side.
  const SKIP_ON_SCHEDULE = "github.event_name != 'schedule'";
  const GATED_ON = /^steps\.([\w-]+)\.outcome == 'success'$/;

  test("on the nightly schedule only the checkout, the plan, and (weekly) codeql can run", () => {
    const stoodDown = new Set<string>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const step of checkSteps) {
        const clauses = clausesOf(step.if);
        const excluded =
          clauses.includes(SKIP_ON_SCHEDULE) ||
          clauses.some((clause) => stoodDown.has(GATED_ON.exec(clause)?.[1] ?? ""));
        if (excluded && !stoodDown.has(label(step))) {
          stoodDown.add(label(step));
          grew = true;
        }
      }
    }
    const reachable = checkSteps.filter((step) => !stoodDown.has(label(step))).map(label);
    expect(reachable).toEqual(BARE_STEPS);

    const SCHEDULE_RUNS = new Set([CHECKS_JOB, "codeql"]);
    const sideOf = (job: Job): string => {
      const clauses = clausesOf(job.if);
      if (
        clauses.includes(SKIP_ON_SCHEDULE) ||
        clauses.includes("github.event_name == 'pull_request'")
      ) {
        return "never on the schedule";
      }

      return "every event";
    };
    const sides = Object.entries(fleet.jobs).map(([name, job]) => [name, sideOf(job)]);
    expect(sides).toEqual(
      Object.keys(fleet.jobs).map((name) => [
        name,
        SCHEDULE_RUNS.has(name) ? "every event" : "never on the schedule",
      ]),
    );
    expect(clausesOf(fleet.jobs.codeql?.if)).toContain(
      `(github.event_name != 'schedule' || needs.${CHECKS_JOB}.outputs.weekly == 'true')`,
    );
  });

  // GitHub resolves a read of an output nobody sets to '' with no error, so a misspelled output skips the skeleton's leg
  // forever, green. Every read is walked to the step that sets it, under ONE name the whole way:
  //   skeleton needs.platform.outputs.X -> fleet.yml workflow_call X -> jobs.standard-checks.outputs.X
  //     -> steps.plan.outputs.X -> actions/plan declares X
  // A wire to another name is a swap nothing else catches, so it fails here too.
  const actionOutputs = (uses: string): string[] | null => {
    const name = platformAction(uses);
    if (name === undefined) return null;
    const path = join(ROOT, "actions", name, "action.yml");
    if (!existsSync(path)) return [];
    const action = parseYaml(readFileSync(path, "utf8")) as { outputs?: Record<string, unknown> };
    return Object.keys(action.outputs ?? {});
  };
  /** Why `steps.<id>.outputs.<name>` inside `job` resolves to nothing, or null when a declared output sets it. */
  const stepOutputGap = (job: Job, id: string, output: string): string | null => {
    const step = job.steps?.find((candidate) => candidate.id === id);
    if (step === undefined) return `no step '${id}'`;
    const declared = step.uses === undefined ? null : actionOutputs(step.uses);
    if (declared === null) return null;
    return declared.includes(output) ? null : `'${step.uses}' declares no output '${output}'`;
  };
  /** Why `needs.<job>.outputs.<name>` resolves to nothing, or null when the job wires it to a step that sets it; a call
   *  job's outputs are the called workflow's. */
  const jobOutputGap = (workflow: Workflow, jobName: string, output: string): string | null => {
    const job = workflow.jobs[jobName];
    if (job === undefined) return `no job '${jobName}'`;
    if (job.uses !== undefined) {
      const called = /^\$\/\.github\/workflows\/(.+)$/.exec(job.uses)?.[1];
      return called === undefined
        ? `job '${jobName}' calls ${job.uses}, not a platform workflow`
        : callOutputGap(loadWorkflow(called), output);
    }
    const value = job.outputs?.[output];
    if (value === undefined) return `job '${jobName}' declares no output '${output}'`;
    const [id, name] = wiredTo(value, "steps");
    if (id === undefined) {
      return `job '${jobName}' output '${output}' is ${value}, not one step output`;
    }
    if (name !== output) {
      return `job '${jobName}' output '${output}' is wired to steps.${id}.outputs.${name}, another name`;
    }
    return stepOutputGap(job, id, name);
  };
  /** Why a caller's `needs.<call>.outputs.<name>` resolves to nothing, or null when the called workflow wires it through. */
  const callOutputGap = (called: Workflow, output: string): string | null => {
    const value = called.on.workflow_call.outputs?.[output]?.value;
    if (value === undefined) return `workflow_call declares no output '${output}'`;
    const [job, name] = wiredTo(value, "jobs");
    if (job === undefined)
      return `workflow_call output '${output}' is ${value}, not one job output`;
    if (name !== output) {
      return `workflow_call output '${output}' is wired to jobs.${job}.outputs.${name}, another name`;
    }
    return jobOutputGap(called, job, name);
  };

  // release-please's branch convention is an external fact the platform cannot enforce; two jobs read it in YAML and
  // release-health in TypeScript, and a prefix misspelled in one place leaves that job skipped forever, green.
  test("the release PR is one prefix on github.head_ref: fleet.yml's release-pr job, the skeleton's release-gate job, and release-health agree", () => {
    const skeleton = parseYaml(shippedSource("files/base/.github/workflows/ci.yml")) as Workflow;
    expect({
      releasePr: prefixesOf(fleet.jobs["release-pr"]?.if),
      releaseGate: prefixesOf(skeleton.jobs["release-gate"]?.if),
    }).toEqual({ releasePr: [RELEASE_BRANCH_PREFIX], releaseGate: [RELEASE_BRANCH_PREFIX] });
  });

  /** The gaps behind one job's reads of needs.*.outputs.* and steps.*.outputs.*, wherever in the job they sit. */
  const jobReadGaps = (jobName: string, job: Job): string[] => {
    const gaps: string[] = [];
    for (const [context, from, output] of outputReads(job)) {
      const gap =
        context === "needs" ? jobOutputGap(fleet, from, output) : stepOutputGap(job, from, output);
      if (gap !== null) {
        gaps.push(`fleet.yml job '${jobName}' reads ${context}.${from}.outputs.${output}: ${gap}`);
      }
    }
    return gaps;
  };

  test("every output read resolves to a step that sets it: the skeleton's through fleet.yml's workflow_call, the jobs', and the steps'", () => {
    const gaps: string[] = [];
    const skeleton = parseYaml(shippedSource("files/base/.github/workflows/ci.yml"));
    const skeletonReads = new Set(
      outputReads(skeleton)
        .filter(([context, job]) => context === "needs" && job === "platform")
        .map(([, , output]) => output),
    );
    for (const output of skeletonReads) {
      const gap = callOutputGap(fleet, output);
      if (gap !== null) gaps.push(`skeleton reads needs.platform.outputs.${output}: ${gap}`);
    }
    for (const [jobName, job] of Object.entries(fleet.jobs)) {
      gaps.push(...jobReadGaps(jobName, job));
    }
    expect({ gaps, skeletonReadsWalked: [...skeletonReads].length > 0 }).toEqual({
      gaps: [],
      skeletonReadsWalked: true,
    });
  });
});

// GitHub fails a job whose condition errors, and fromJSON errors on the empty text a failed plan's output reads as.
// Every other clause holds here, so the job's own sentinel is what keeps a failed plan a skip and not a second red.
test("fleet.yml: a job selected by module stands down, without an error, after a plan that published no modules", () => {
  const verdicts = Object.entries(fleet.jobs)
    .filter(([, job]) => job.if?.includes(`fromJSON(needs.${CHECKS_JOB}.outputs.modules)`))
    .map(([id, job]) => [
      id,
      evaluateCondition(job.if ?? "", {
        "github.event_name": "pull_request",
        "github.head_ref": `${RELEASE_BRANCH_PREFIX}branches--main`,
        [`needs.${CHECKS_JOB}.result`]: "failure",
      }),
    ]);

  expect(Object.fromEntries(verdicts)).toEqual({ "docs-check": false, "release-pr": false });
});
