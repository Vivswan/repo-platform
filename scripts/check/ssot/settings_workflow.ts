import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  parse as parseYaml,
  type Scalar,
} from "yaml";
import {
  identityKeyIssues,
  loadOverrideLayer,
} from "../../../.github/scripts/sync/writer/merge_settings_layers.ts";
import type { Mismatch } from "./comparison.ts";
import { asRecord, REPO_ROOT, read } from "./inputs.ts";
import { FLEET_WRITERS, POST_GREEN_REL } from "./post_green.ts";
import type { Rule } from "./rule_roster.ts";

interface WorkflowStep {
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
function stepsOf(text: string, rel: string): WorkflowStep[] {
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
export const SETTINGS_ACTION_USES =
  "Vivswan/github-settings-as-code@046adf3b24454f26f569850630809bcf481f8b84 # v2.0.0";

/** YAML also attaches an indented comment on the NEXT line as the scalar's
 *  trailing comment; the release-tag verification reads the `uses` line
 *  alone, so only a comment on the scalar's own line counts. */
function sameLineComment(scalar: Scalar, lines: LineCounter): string | null {
  const token = scalar.srcToken;
  if (typeof scalar.comment !== "string" || scalar.range == null || token === undefined) {
    return null;
  }
  const comment = "end" in token ? token.end?.find((t) => t.type === "comment") : undefined;
  if (comment === undefined) return null;
  const sameLine = lines.linePos(comment.offset).line === lines.linePos(scalar.range[1]).line;
  return sameLine ? scalar.comment : null;
}

function applyUsesPins(text: string): string[] {
  const pins: string[] = [];
  const lines = new LineCounter();
  const jobs = parseDocument(text, { keepSourceTokens: true, lineCounter: lines }).get("jobs");
  if (!isMap(jobs)) return pins;
  for (const job of jobs.items) {
    const steps = isMap(job.value) ? job.value.get("steps") : undefined;
    if (!isSeq(steps)) continue;
    for (const step of steps.items) {
      const uses = isMap(step) ? step.get("uses", true) : undefined;
      if (!isScalar(uses) || !String(uses.value).includes("github-settings-as-code")) continue;
      const comment = sameLineComment(uses, lines);
      pins.push(`${String(uses.value)}${comment === null ? "" : ` #${comment.trimEnd()}`}`);
    }
  }
  return pins;
}

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

/** The apply is a matrix of one target per job, each row keyed by the selector and resolved in its own job:
 *  a slug in the matrix or a re-selection in the apply job would name a private repository or re-run the plan's
 *  probes per row, and an empty repos input is the action's single-repo mode over this checkout's document.
 *  The with: block is matched whole: `repository`, `settings-file`, `defaults-file`, or `repos-dir` would apply
 *  a document other than each target's own rendered file. */
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
  const applying = Object.entries(jobs).filter(([, job]) =>
    stepsIn(job).some((step) => String(step.uses ?? "").includes("github-settings-as-code")),
  );
  if (applying.length === 0)
    throw new Error(`${rel}: no github-settings-as-code step - anchor lost`);
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
      expected: "one job running github-settings-as-code (the matrix job, one target per row)",
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
  const matrix = `\${{ fromJSON(needs.${planName}.outputs.matrix) }}`;
  if (apply.strategy?.matrix !== matrix) {
    mismatches.push({
      file: rel,
      expected: `the ${applyName} job's matrix the plan's row indexes and keys alone: matrix: ${matrix}`,
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
  const isApply = (step: WorkflowStep) =>
    String(step.uses ?? "").includes("github-settings-as-code");
  const applies = applySteps.filter(isApply);
  if (applies.length !== 1) {
    mismatches.push({
      file: rel,
      expected: "one github-settings-as-code step in the apply job (one target per row)",
      got: `${applies.length} steps`,
    });
  }
  // The version comment is not in the parsed step, so the pin is read off
  // the document's own `uses` scalar (value plus trailing comment): text
  // elsewhere in the file can neither satisfy nor hide it.
  const usesLine = `uses: ${SETTINGS_ACTION_USES}`;
  const pins = applyUsesPins(text);
  const allApplies = Object.values(jobs).flatMap((job) => stepsIn(job).filter(isApply));
  if (pins.length !== allApplies.length) {
    mismatches.push({
      file: rel,
      expected: `${usesLine} as a plain scalar on every apply step`,
      got: `${pins.length} readable pin(s) for ${allApplies.length} step(s) (an alias or a non-scalar uses)`,
    });
  }
  for (const pin of pins) {
    if (pin !== SETTINGS_ACTION_USES) mismatches.push({ file: rel, expected: usesLine, got: pin });
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
  const resolver = applySteps[resolverAt];
  const resolverEnv = {
    ROW_KEY: "${{ matrix.key }}",
    PAT: "${{ secrets.REPO_PLATFORM_TOKEN }}",
    GH_TOKEN: "${{ secrets.REPO_PLATFORM_TOKEN }}",
    OWNER: "${{ github.repository_owner }}",
  };
  const env = resolver.env ?? {};
  if (
    JSON.stringify(env, Object.keys(env).sort()) !==
    JSON.stringify(resolverEnv, Object.keys(resolverEnv).sort())
  ) {
    mismatches.push({
      file: rel,
      expected: `the resolver step's env exactly ${JSON.stringify(resolverEnv)} (the row's key, what keyed it, and the listing it resolves against)`,
      got: JSON.stringify(env, Object.keys(env).sort()),
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
  const wanted = {
    token: "${{ secrets.REPO_PLATFORM_TOKEN }}",
    mode: "${{ inputs.check_only && 'check' || 'apply' }}",
    repos: "${{ env.TARGET }}",
    "private-repos": "redact",
    "private-report": "issue",
    "on-missing-permission": "fail",
  };
  for (const step of allApplies) {
    if (String(step.if ?? "").trim() !== stepGate) {
      mismatches.push({
        file: rel,
        expected: `the apply step gated on if: ${stepGate}`,
        got: step.if === undefined ? "no condition" : `if: ${String(step.if)}`,
      });
    }
    const got = JSON.stringify(step.with ?? {}, Object.keys(step.with ?? {}).sort());
    if (got !== JSON.stringify(wanted, Object.keys(wanted).sort())) {
      mismatches.push({
        file: rel,
        expected: `the apply step's with: exactly ${JSON.stringify(wanted)}`,
        got,
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
      const overrideRulesets = (override.rulesets ?? []) as Record<string, unknown>[];
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
    // and nothing else, each target's own rendered document, under the
    // tagged pin, one job per target.
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
