import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  identityKeyIssues,
  loadOverrideLayer,
  sectionEntries,
} from "../../../.github/scripts/sync/writer/settings_layers.ts";
import { canonical, type Mismatch } from "./comparison.ts";
import { asRecord, REPO_ROOT, read } from "./inputs.ts";
import { FLEET_WRITERS, POST_GREEN_REL } from "./post_green.ts";
import type { Rule } from "./rule_roster.ts";

/** The `include` word in the workflow, the rows from the plan's output alone: a literal could carry slugs, and
 *  the word in the output could match a masked name. */
const keyedMatrix = (planJob: string) => ({
  include: `\${{ fromJSON(needs.${planJob}.outputs.matrix) }}`,
});
/** The row's key, what keyed it, and the listing it resolves against. */
const RESOLVER_ENV = {
  ROW_KEY: "${{ matrix.key }}",
  PAT: "${{ secrets.REPO_PLATFORM_TOKEN }}",
  GH_TOKEN: "${{ secrets.REPO_PLATFORM_TOKEN }}",
  OWNER: "${{ github.repository_owner }}",
};

export interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  run?: string;
  "continue-on-error"?: boolean | string;
}

/** Rules about steps read the parsed document, never the file's text:
 *  a matching string in a comment, or on some other step, must not satisfy them. */
export function stepsOf(text: string, rel: string): WorkflowStep[] {
  const doc = asRecord(parseYaml(text), rel);
  const jobs = asRecord(doc.jobs ?? {}, `${rel} jobs`);
  const steps: WorkflowStep[] = [];
  for (const job of Object.values(jobs)) {
    const list = asRecord(job ?? {}, `${rel} job`).steps;
    if (!Array.isArray(list)) continue;
    for (const step of list) steps.push(asRecord(step, `${rel} step`) as WorkflowStep);
  }
  return steps;
}

function workflowSteps(rel: string): WorkflowStep[] {
  return stepsOf(read(rel), rel);
}

/** An unrun step's ABSENT output compares as the number 0 in Actions, so only `== '<non-zero literal>'` and `!= ''` cannot be satisfied by one.
 *  Terms without a step output (`env.*`, `needs.*`) are not this hazard. */
export function unsafeStepCondition(condition: string): string | null {
  const OUTPUT = /steps\.[\w-]+\.outputs\./;
  if (!OUTPUT.test(condition)) return null;
  // A negated GROUP inverts terms this check reads term by term, so it
  // cannot be proven safe here. `!cancelled()` and friends do not match:
  // the parenthesis has to follow the `!` directly.
  if (/!\s*\(/.test(condition)) return `a negated group: ${condition.trim()}`;
  for (const raw of condition.split(/&&|\|\|/)) {
    const term = raw.replaceAll(/[()]/g, "").trim();
    if (!OUTPUT.test(term)) continue;
    const match = /^steps\.[\w-]+\.outputs\.[\w-]+ (==|!=) '([^']*)'$/.exec(term);
    if (match === null) return term;
    const [, operator, literal] = match;
    if (operator === "==" ? Number(literal) === 0 : literal !== "") return term;
  }
  return null;
}

/** FAIL steps (a bare `exit <non-zero>` last line, no continue-on-error) are exempt:
 *  a gate that opens on an absent output there turns the job red, which is the point. */
export function stepOutputGateMismatches(rel: string, steps: WorkflowStep[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const step of steps) {
    const failStep =
      /(^|\n)\s*exit [1-9]\d*$/.test(String(step.run ?? "").trimEnd()) &&
      !step["continue-on-error"];
    if (failStep) continue;
    const unsafe = unsafeStepCondition(String(step.if ?? ""));
    if (unsafe !== null) {
      mismatches.push({
        file: rel,
        expected: `step "${step.id ?? step.name ?? step.uses}" tests step outputs positively`,
        got: `${unsafe} (a step that did not run has an ABSENT output, which passes)`,
      });
    }
  }
  return mismatches;
}

/** This repository's own overlay: the writer renders the root
 *  .github/settings.yml from it, so its identity keys are judged here on
 *  the same contract (identityKeyIssues) the merge dialect applies. */
export const OWN_OVERLAY = ".github/settings.local.yml";

export function settingsIdentityMismatches(repository: Record<string, unknown>): Mismatch[] {
  return identityKeyIssues(repository).map((issue) => ({
    file: `${OWN_OVERLAY} repository.${issue.key}`,
    expected: issue.expected,
    got: issue.got,
  }));
}

export const SETTINGS_STARTERS = [
  "files/base/.github/settings.local.yml",
  "files/base/.github/settings.local.private.yml",
];

export const OVERRIDE_RULESETS = ["main", "non-bypassable"];

/** A labels or rulesets section would seed every new repository with a shadowing copy of baseline entries, frozen at the first write.
 *  The starters' placeholders sit inside quoted scalars, so the source parses as written without neutralizing them. */
export function starterMismatches(rel: string, text: string): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const starter = asRecord(parseYaml(text), rel);
  const repository = asRecord(starter.repository, `${rel} repository`);
  for (const key of ["description", "homepage", "topics", "private"]) {
    if (!(key in repository)) {
      mismatches.push({
        file: rel,
        expected: `repository.${key} seeded by the writer`,
        got: "missing - the starter must declare all four identity keys",
      });
    }
  }
  for (const section of ["labels", "rulesets"]) {
    if (starter[section] !== undefined) {
      mismatches.push({
        file: rel,
        expected: `no ${section} section (the fleet layers supply it; the starter only shows commented examples)`,
        got: "declared",
      });
    }
  }
  return mismatches;
}

export function overlayMismatches(text: string): Mismatch[] {
  const own = asRecord(parseYaml(text), OWN_OVERLAY);
  const mismatches = settingsIdentityMismatches(
    asRecord(own.repository, `${OWN_OVERLAY} repository`),
  );
  const rulesets = Array.isArray(own.rulesets)
    ? own.rulesets.map((r) => asRecord(r, `${OWN_OVERLAY} ruleset`))
    : [];
  for (const name of OVERRIDE_RULESETS) {
    if (rulesets.some((ruleset) => ruleset.name === name)) {
      mismatches.push({
        file: OWN_OVERLAY,
        expected: `no '${name}' ruleset (the override layer supplies it and wins over this file)`,
        got: "declared, which the merge silently overrides",
      });
    }
  }
  return mismatches;
}

export const SETTINGS_WORKFLOW = ".github/workflows/settings-repos.yml";
export const SETTINGS_SELECTOR = "bun .github/scripts/fleet/select_settings_repos.ts";
export const SETTINGS_RESOLVER = "bun .github/scripts/fleet/resolve_settings_target.ts";
/** The apply is the installed library's own bin, so bun.lock's one resolved version is the writer's fold and the
 *  apply's engine at once; `$TARGET` rides GITHUB_ENV from the resolver, `$MODE` the step's env. */
export const SETTINGS_APPLY_RUN =
  'bun run gsac "$MODE" --repos "$TARGET" --private-repos redact --private-report issue --on-missing-permission fail --summary "$GITHUB_STEP_SUMMARY"';
export const SETTINGS_APPLY_ENV = {
  GITHUB_TOKEN: "${{ secrets.REPO_PLATFORM_TOKEN }}",
  MODE: "${{ inputs.check_only && 'check' || 'apply' }}",
};

interface WorkflowJob {
  name?: string;
  needs?: string | string[];
  if?: string;
  concurrency?: unknown;
  strategy?: { "fail-fast"?: boolean; matrix?: unknown };
  outputs?: Record<string, unknown>;
  steps?: WorkflowStep[];
}

function jobsOf(text: string, rel: string): Record<string, WorkflowJob> {
  const doc = asRecord(parseYaml(text), rel);
  const jobs = asRecord(doc.jobs ?? {}, `${rel} jobs`);
  return Object.fromEntries(
    Object.entries(jobs).map(([name, job]) => [name, asRecord(job ?? {}, `${rel} job`)]),
  ) as Record<string, WorkflowJob>;
}

/** GitHub orders a lane by ARRIVAL and CI durations vary, so with `cancel-in-progress: true` an older commit's late run would
 *  cancel the newer apply mid-flight and then stand down itself (select_settings_repos.ts), leaving the fleet unapplied until
 *  the nightly. Both holders are judged: the writer's own group and the caller job's. */
export function settingsLaneMismatches(workflowText: string, postGreenText: string): Mismatch[] {
  const caller = FLEET_WRITERS[SETTINGS_WORKFLOW].callerJob;
  const holders: [string, unknown][] = [
    [SETTINGS_WORKFLOW, asRecord(parseYaml(workflowText), SETTINGS_WORKFLOW).concurrency],
    [`${POST_GREEN_REL} job ${caller}`, jobsOf(postGreenText, POST_GREEN_REL)[caller]?.concurrency],
  ];
  const mismatches: Mismatch[] = [];
  for (const [file, lane] of holders) {
    const cancel = asRecord(lane ?? {}, `${file} concurrency`)["cancel-in-progress"];
    if (cancel === false) continue;
    mismatches.push({
      file,
      expected:
        "cancel-in-progress: false on the settings lane (a lane orders by arrival, so cancelling would let an older commit's late run cancel the newer apply in flight; the selector stands that run down instead)",
      got:
        lane === undefined
          ? "no concurrency block"
          : cancel === undefined
            ? "cancel-in-progress unset"
            : `cancel-in-progress: ${String(cancel)}`,
    });
  }
  return mismatches;
}

const stepsIn = (job: WorkflowJob): WorkflowStep[] => (Array.isArray(job.steps) ? job.steps : []);
const runOf = (step: WorkflowStep): string => String(step.run ?? "").trim();
/** Any step that names the library in one of its strings (a run line, a `uses`, a script handed to another
 *  action) is an invocation; the rule then requires the one route bun.lock pins, so a second route is a mismatch,
 *  never a pass. Each string is tested as written: a serialized step would spell a newline `\\n`, and that `n`
 *  would defeat the word boundary before `gsac`. */
const SETTINGS_INVOCATION = /\bgsac\b|github-settings-as-code/;
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(strings);
}
const isApply = (step: WorkflowStep): boolean =>
  strings(step).some((text) => SETTINGS_INVOCATION.test(text));
const invocationOf = (step: WorkflowStep): string =>
  step.run === undefined ? `uses: ${String(step.uses)}` : `run: ${runOf(step)}`;

/** The apply is a matrix of one target per job, each row keyed by the selector and resolved in its own job:
 *  a slug in the matrix or a re-selection in the apply job would name a private repository or re-run the plan's
 *  probes per row, and an empty --repos is the CLI's single-repo mode over this checkout's document.
 *  The run line is matched whole: a `--repository`, `--settings-file`, `--defaults-file`, or `--repos-dir` would
 *  apply a document other than each target's own rendered file. */
export function settingsApplyInputMismatches(text: string): Mismatch[] {
  const rel = SETTINGS_WORKFLOW;
  const jobs = jobsOf(text, rel);
  const selecting = Object.entries(jobs).filter(([, job]) =>
    stepsIn(job).some((step) => runOf(step) === SETTINGS_SELECTOR),
  );
  if (selecting.length === 0) throw new Error(`${rel}: no target-selection step - anchor lost`);
  const [planName, plan] = selecting[0];
  const selectors = Object.values(jobs).flatMap((job) =>
    stepsIn(job).filter((step) => runOf(step) === SETTINGS_SELECTOR),
  );
  const applying = Object.entries(jobs).filter(([, job]) => stepsIn(job).some(isApply));
  if (applying.length === 0)
    throw new Error(`${rel}: no step running the settings library - anchor lost`);
  const mismatches: Mismatch[] = [];
  if (selectors.length !== 1) {
    mismatches.push({
      file: rel,
      expected:
        "one selection step in the whole workflow (a re-selection could move a row onto another repository)",
      got: `${selectors.length} steps running ${SETTINGS_SELECTOR}, in jobs ${selecting.map(([name]) => name).join(", ")}`,
    });
  }
  if (applying.length !== 1) {
    mismatches.push({
      file: rel,
      expected: "one job running the settings library (the matrix job, one target per row)",
      got: `${applying.length} jobs`,
    });
  }
  const [applyName, apply] = applying[0];
  if (applyName === planName) {
    mismatches.push({
      file: rel,
      expected: "the apply in a matrix job of its own, fed by the selecting job's outputs",
      got: `the selector and the apply both in the ${planName} job`,
    });
  }

  const selectId = String(selectors[0].id ?? "");
  for (const [output, source] of [
    ["count", `\${{ steps.${selectId}.outputs.count }}`],
    ["matrix", `\${{ steps.${selectId}.outputs.matrix }}`],
  ] as const) {
    const got = plan.outputs?.[output];
    if (got !== source) {
      mismatches.push({
        file: rel,
        expected: `the ${planName} job's ${output} output wired to the selector's (${output}: ${source})`,
        got: got === undefined ? `no ${output} output` : `${output}: ${String(got)}`,
      });
    }
  }

  const needs = Array.isArray(apply.needs) ? apply.needs : [apply.needs];
  if (!needs.includes(planName)) {
    mismatches.push({
      file: rel,
      expected: `the ${applyName} job needing ${planName}`,
      got: apply.needs === undefined ? "no needs" : `needs: ${JSON.stringify(apply.needs)}`,
    });
  }
  const gate = `needs.${planName}.outputs.count != '0'`;
  if (String(apply.if ?? "").trim() !== gate) {
    mismatches.push({
      file: rel,
      expected: `the ${applyName} job gated on if: ${gate} (an empty matrix is a no-op, not a failure)`,
      got: apply.if === undefined ? "no condition" : `if: ${String(apply.if)}`,
    });
  }
  const matrix = keyedMatrix(planName);
  if (canonical(apply.strategy?.matrix) !== canonical(matrix)) {
    mismatches.push({
      file: rel,
      expected: `the ${applyName} job's matrix the plan's row indexes and keys alone: matrix: ${JSON.stringify(matrix)}`,
      got:
        apply.strategy?.matrix === undefined
          ? "no matrix"
          : `matrix: ${JSON.stringify(apply.strategy.matrix)}`,
    });
  }
  if (apply.strategy?.["fail-fast"] !== false) {
    mismatches.push({
      file: rel,
      expected: `fail-fast: false on the ${applyName} job (one target's failure is its own row's red)`,
      got:
        apply.strategy?.["fail-fast"] === undefined
          ? "fail-fast unset (GitHub's default cancels the other rows)"
          : `fail-fast: ${String(apply.strategy["fail-fast"])}`,
    });
  }
  const jobName = `${applyName} (row \${{ matrix.row }})`;
  if (String(apply.name ?? "") !== jobName) {
    mismatches.push({
      file: rel,
      expected: `the ${applyName} job named ${jobName} - an index, never a repository`,
      got: `name: ${String(apply.name ?? "(none)")}`,
    });
  }

  const applySteps = stepsIn(apply);
  const applies = applySteps.filter(isApply);
  if (applies.length !== 1) {
    mismatches.push({
      file: rel,
      expected: "one settings-library step in the apply job (one target per row)",
      got: `${applies.length} steps`,
    });
  }

  // TARGET is job env, so only the step right before the apply may write it: a step between the
  // resolver and the apply could rewrite it. Without a resolver the gate and the input read nothing.
  const resolverAt = applySteps.findIndex((step) => runOf(step) === SETTINGS_RESOLVER);
  const applyAt = applySteps.findIndex(isApply);
  if (resolverAt === -1 || resolverAt !== applyAt - 1) {
    mismatches.push({
      file: rel,
      expected: `a step running ${SETTINGS_RESOLVER} IMMEDIATELY BEFORE the apply step (it registers the target's masks and writes TARGET)`,
      got:
        resolverAt === -1
          ? "no resolver step"
          : resolverAt > applyAt
            ? "the resolver after the apply step"
            : `${applyAt - resolverAt - 1} step(s) between the resolver and the apply`,
    });
    if (resolverAt === -1) return mismatches;
  }
  const resolverEnv = applySteps[resolverAt].env ?? {};
  if (canonical(resolverEnv) !== canonical(RESOLVER_ENV)) {
    mismatches.push({
      file: rel,
      expected: `the resolver step's env exactly ${JSON.stringify(RESOLVER_ENV)} (the row's key, what keyed it, and the listing it resolves against)`,
      got: canonical(resolverEnv),
    });
  }
  // The runner prints step env into the public log; the name rides GITHUB_ENV.
  for (const step of applySteps) {
    if ("TARGET" in (step.env ?? {})) {
      mismatches.push({
        file: rel,
        expected:
          "no TARGET in an apply step's env (the runner prints step env; the name rides GITHUB_ENV)",
        got: `step "${String(step.name ?? step.id ?? step.uses)}" declares TARGET`,
      });
    }
  }
  const stepGate = "env.TARGET != ''";
  const allApplies = Object.values(jobs).flatMap((job) => stepsIn(job).filter(isApply));
  for (const step of allApplies) {
    if (String(step.if ?? "").trim() !== stepGate) {
      mismatches.push({
        file: rel,
        expected: `the apply step gated on if: ${stepGate}`,
        got: step.if === undefined ? "no condition" : `if: ${String(step.if)}`,
      });
    }
    if (runOf(step) !== SETTINGS_APPLY_RUN) {
      mismatches.push({
        file: rel,
        expected: `run: ${SETTINGS_APPLY_RUN}`,
        got: invocationOf(step),
      });
    }
    if (canonical(step.env) !== canonical(SETTINGS_APPLY_ENV)) {
      mismatches.push({
        file: rel,
        expected: `the apply step's env exactly ${JSON.stringify(SETTINGS_APPLY_ENV)} (the fleet token the CLI reads, and the mode check_only picks)`,
        got: step.env === undefined ? "no env" : canonical(step.env),
      });
    }
  }
  return mismatches;
}

export const settingsWorkflowRules: Rule[] = [
  {
    name: "settings-starter",
    run: () => {
      // The override layer must still own the rulesets the overlay is
      // judged against, or the judgment is vacuous.
      const override = loadOverrideLayer(join(REPO_ROOT, "files/settings/override.yml"));
      const overrideRulesets = sectionEntries(override.doc, "rulesets");
      for (const name of OVERRIDE_RULESETS) {
        if (!overrideRulesets.some((ruleset) => ruleset.name === name)) {
          throw new Error(`files/settings/override.yml: no ${name} ruleset - anchor lost`);
        }
      }
      return [
        ...SETTINGS_STARTERS.flatMap((rel) => starterMismatches(rel, read(rel))),
        ...overlayMismatches(read(OWN_OVERLAY)),
      ];
    },
  },
  {
    // Every workflow, not only settings-repos.yml: a condition that tests
    // a step output negatively passes when the step never ran, wherever
    // the guarded step is a push, a PR, or an issue write.
    name: "step-output-gates",
    run: () =>
      readdirSync(join(REPO_ROOT, ".github/workflows"))
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => `.github/workflows/${name}`)
        .flatMap((rel) => stepOutputGateMismatches(rel, workflowSteps(rel))),
  },
  {
    // The apply reconciles labels and rulesets on every target it is
    // handed, so what it is handed is load-bearing: the plan's keyed row
    // and nothing else, each target's own rendered document, through the
    // installed library's bin, one job per target.
    name: "settings-apply-input",
    run: () => settingsApplyInputMismatches(read(SETTINGS_WORKFLOW)),
  },
  {
    // Newest wins has two halves: the selector stands a superseded run
    // down, and the lane lets the newer run finish. This pins the second.
    name: "settings-lane-newest-wins",
    run: () => settingsLaneMismatches(read(SETTINGS_WORKFLOW), read(POST_GREEN_REL)),
  },
];
