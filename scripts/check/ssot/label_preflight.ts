// The rule pinning the fail-closed label preflight's landed shape: the
// settings-repos.yml step that runs it (byte-identical run line, step
// keys, env, the gap to the apply, the apply's input census) and the
// argv settings_layer_step.ts builds for its labels leg (deep-equal for
// the operator row and a fetched row). tests/fleet/settings_layer_step.test.ts
// proves the script runs exactly that argv. The action's merge step (mode:
// merge, before the preflight) is not an apply and sits outside the pin.

import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type LayerStepFacts,
  layerStepArgv,
} from "../../../.github/scripts/fleet/settings_layer_step.ts";
import { firstDiff, type Mismatch } from "./comparison.ts";
import { asRecord, REPO_ROOT, read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The preflight script's path stem, and the layer step that runs it. */
export const PREFLIGHT_SCRIPT = "fleet/label_preflight.ts";
export const LAYER_STEP_SCRIPT = "fleet/settings_layer_step.ts";

/** Whether a run block invokes the layer step's labels leg somewhere in
 *  its text. Recognition only: the byte pin below judges the block. */
export function invokesPreflightLeg(run: string): boolean {
  return /settings_layer_step\.ts\s+labels(?=\s|$)/.test(run);
}

/** Lenient mapping view of parsed YAML for the preflight judge; a
 *  non-mapping reads as empty, so shape checks mismatch instead of
 *  throwing on malformed steps. */
function asMapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A step that runs the settings action against a repository: the
 *  action's merge-mode step folds files and touches nothing, so it is not
 *  the apply the preflight guards. */
export function isApplyStep(step: Record<string, unknown>): boolean {
  return (
    String(step.uses ?? "").includes("github-settings-as-code") &&
    String(asMapping(step.with).mode ?? "").trim() !== "merge"
  );
}

/** The preflight step's run block, byte-for-byte: a textual rule cannot
 *  prove EXECUTION of anything looser (a `|| true`, a rerouted shell, a
 *  substituted script), so ANY deviation mismatches, and a deliberate
 *  edit updates this constant in the same change. Exported so the suite
 *  can prove the comparison fires. */
export const PREFLIGHT_EXPECTED_RUN: Record<string, string> = {
  ".github/workflows/settings-repos.yml": "bun .github/scripts/fleet/settings_layer_step.ts labels",
};

/** The rows the labels leg is judged on: both target kinds in both
 *  modes, so a builder that folds one mode into the other (the regression
 *  that would let a normal apply delete referenced labels after a warning)
 *  cannot pass. Every placeholder value is distinct, so a swapped, dropped,
 *  or repeated flag value is visible. */
export const PREFLIGHT_ARGV_ROWS = [
  "operator-apply",
  "operator-check",
  "target-apply",
  "target-check",
] as const;
export type PreflightArgvRow = (typeof PREFLIGHT_ARGV_ROWS)[number];

const PINNED_SHA = "0123456789abcdef0123456789abcdef01234567";
export const PREFLIGHT_ARGV_FACTS: Record<PreflightArgvRow, LayerStepFacts> = {
  "operator-apply": {
    target: "Vivswan/repo-platform",
    operator: true,
    runnerTemp: "/runner/_temp",
    pinned: PINNED_SHA,
    mode: "apply",
  },
  "operator-check": {
    target: "Vivswan/repo-platform",
    operator: true,
    runnerTemp: "/runner/_temp",
    pinned: PINNED_SHA,
    mode: "check",
  },
  "target-apply": {
    target: "Vivswan/managed",
    operator: false,
    runnerTemp: "/runner/_temp",
    pinned: PINNED_SHA,
    mode: "apply",
  },
  "target-check": {
    target: "Vivswan/managed",
    operator: false,
    runnerTemp: "/runner/_temp",
    pinned: PINNED_SHA,
    mode: "check",
  },
};

// The exact argv per row - an ALLOWLIST, not a presence test:
// label_preflight.ts stands down or re-scopes on flags a presence test
// would never look at (--sections, --target-dir, a repeated --mode's last
// value wins), so anything but an exact match is a stood-down guard. The
// wrapper is part of the pin: label names and referencing file paths are
// target content a hide-details log may not carry.
const SCRIPTS = join(REPO_ROOT, ".github/scripts");
const PINNED_HEAD = [
  "bun",
  join(SCRIPTS, "sync/run_hidden.ts"),
  "settings labels",
  "--",
  "bun",
  join(SCRIPTS, "fleet/label_preflight.ts"),
  "--merged",
  "/runner/_temp/merged-settings.yml",
];
export const PREFLIGHT_EXPECTED_ARGV: Record<PreflightArgvRow, string[]> = {
  "operator-apply": [
    ...PINNED_HEAD,
    "--repo",
    "Vivswan/repo-platform",
    "--target-dir",
    ".",
    "--mode",
    "apply",
  ],
  "operator-check": [
    ...PINNED_HEAD,
    "--repo",
    "Vivswan/repo-platform",
    "--target-dir",
    ".",
    "--mode",
    "check",
  ],
  "target-apply": [
    ...PINNED_HEAD,
    "--repo",
    "Vivswan/managed",
    "--ref",
    PINNED_SHA,
    "--mode",
    "apply",
  ],
  "target-check": [
    ...PINNED_HEAD,
    "--repo",
    "Vivswan/managed",
    "--ref",
    PINNED_SHA,
    "--mode",
    "check",
  ],
};

/** The trust boundary the argv pin rests on: the layer step's argv is a
 *  function of the workflow-provided mode and env ONLY, never of repository
 *  content, so the source may import no file reader (node:fs, Bun.file) -
 *  a builder that read the checkout could be steered by the target repo. */
export function layerStepReadsNoFiles(source: string): boolean {
  return !/from\s+"node:fs(\/promises)?"|require\("node:fs|\bBun\.file\(/.test(source);
}

/** The labels leg's argv for every pinned row against the pinned lists.
 *  The builder is injected so the suite can prove the comparison fires on
 *  a drifted argv; the rule passes the live one. */
export function labelPreflightArgvMismatches(
  argvOf: (facts: LayerStepFacts) => string[] = (facts) => layerStepArgv("labels", facts),
  source: string = read(`.github/scripts/${LAYER_STEP_SCRIPT}`),
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  if (!layerStepReadsNoFiles(source)) {
    mismatches.push({
      file: `.github/scripts/${LAYER_STEP_SCRIPT}`,
      expected:
        "no file reader in the layer step (its argv is a function of the workflow-provided mode and env only, never of repository content)",
      got: "a node:fs import or Bun.file call",
    });
  }
  for (const row of PREFLIGHT_ARGV_ROWS) {
    const expected = PREFLIGHT_EXPECTED_ARGV[row];
    const actual = argvOf(PREFLIGHT_ARGV_FACTS[row]);
    const at = firstDiff(expected, actual);
    if (at !== -1) {
      mismatches.push({
        file: `.github/scripts/${LAYER_STEP_SCRIPT} (labels leg, ${row} row)`,
        expected:
          `the pinned argv [${expected.join(" ")}] - an extra, missing, or drifted flag stands ` +
          "the guard down at runtime while every pinned flag still reads present",
        got: `[${actual.join(" ")}] (first difference at element ${at})`,
      });
    }
  }
  return mismatches;
}

/** One apply input's expectation in the census below: mirrored from a
 *  preflight env var AND pinned to one expected expression (text parity alone
 *  is not enough: the same expression string can EVALUATE differently in a
 *  run step's env and a uses step's with, e.g. via github.action, so both
 *  sides must carry the one context-stable expression), a fixed literal, or
 *  presence-only because another rule owns the value (re-pinning it here
 *  would double-report one edit). */
export type ApplyWithExpectation =
  | { parity: string; value: string }
  | { literal: string }
  | { pinnedElsewhere: true };

// The COMPLETE census of each apply step's with: inputs. Every input mirrors
// a preflight env var (the guard must judge under exactly the configuration
// the apply runs with, both sides pinned to one context-stable expression),
// is a fixed literal, or is value-pinned by another rule; a key outside the
// census fails outright, which is what makes the mirrored-input class
// CLOSED. The parity env names, with PREFLIGHT_STEP_ENV_PINS, double as the
// preflight's env-key ALLOWLIST: an env var outside it (BASH_ENV) can inject
// execution the run pin cannot see. Exported so the suite can mutation-test
// every entry.
export const PREFLIGHT_APPLY_WITH: Record<string, Record<string, ApplyWithExpectation>> = {
  ".github/workflows/settings-repos.yml": {
    token: { parity: "GH_TOKEN", value: "${{ secrets.REPO_PLATFORM_TOKEN }}" },
    mode: { parity: "MODE", value: "${{ inputs.check_only && 'check' || 'apply' }}" },
    repository: { parity: "TARGET", value: "${{ steps.resolve.outputs.repo }}" },
    "settings-file": { pinnedElsewhere: true },
    "private-repos": { literal: "redact" },
    "private-report": { literal: "issue" },
    "on-missing-permission": { literal: "fail" },
  },
};

// The preflight step's env vars that mirror no apply input, value-pinned:
// PINNED is the commit the layers step published, which a fetched row's
// preflight reads its reference files at (a drifted expression would judge
// the labels against some other revision's files).
export const PREFLIGHT_STEP_ENV_PINS: Record<string, Record<string, string>> = {
  ".github/workflows/settings-repos.yml": { PINNED: "${{ steps.layers.outputs.ref }}" },
};

/** The env names the preflight step may carry: the mirrored census names
 *  plus the value-pinned extras. */
function preflightEnvNames(rel: string): Set<string> {
  return new Set([
    ...Object.values(PREFLIGHT_APPLY_WITH[rel]).flatMap((expectation) =>
      "parity" in expectation ? [expectation.parity] : [],
    ),
    ...Object.keys(PREFLIGHT_STEP_ENV_PINS[rel]),
  ]);
}

// Job-level env keys the apply job may carry (workflow-level env is
// rejected outright): a job or workflow env var reaches the preflight's
// shell exactly like a step one, so BASH_ENV smuggled one level up is
// the same injection the step-level allowlist closes.
export const PREFLIGHT_JOB_ENV_KEYS: Record<string, ReadonlySet<string>> = {
  ".github/workflows/settings-repos.yml": new Set(["HIDE_DETAILS", "SETTINGS_REPORT_TITLE"]),
};

// The job-level EXECUTION-CONTEXT census, a rule rather than an accepted
// residual because the class is in-file and closable: `container:` re-homes
// every step into an image whose env and PATH arrive underneath the env
// allowlists' sight, `services:` attaches containers, and runner keys keep
// being added, so the apply job's keys are ALLOWLISTED rather than
// enumerated as hazards, with runs-on value-pinned to the hosted runner the
// byte-pinned run blocks assume. `defaults:` is absent here because its
// dedicated check owns it; `env:` is a KEY here, PREFLIGHT_JOB_ENV_KEYS judges its content.
export const PREFLIGHT_APPLY_JOB_KEYS: Record<string, ReadonlySet<string>> = {
  ".github/workflows/settings-repos.yml": new Set([
    "name",
    "needs",
    "if",
    "strategy",
    "env",
    "runs-on",
    "timeout-minutes",
    "steps",
  ]),
};

/** The one hosted runner the apply job may request. */
export const PREFLIGHT_APPLY_RUNS_ON = "ubuntu-latest";

// The persisted-environment class: a PRIOR step can write `BASH_ENV=<hook>
// >> $GITHUB_ENV` (bash sources the hook before the pinned run block, and an
// `exit 0` there skips the guard green) or prepend a counterfeit bun via
// GITHUB_PATH. No landed apply-job step touches these, so ANY mention in a
// run block mismatches. Recorded residuals: the called scripts are this
// repo's own CI-gated code (the trust boundary is the WORKFLOW FILE plus
// the argv pin above), and the scan catches LITERAL spellings; an
// obfuscated write is adversarial code in a reviewed file, outside any
// textual rule's reach, and stays review's.
export const PREFLIGHT_FORBIDDEN_RUN_TOKENS = ["GITHUB_ENV", "BASH_ENV", "GITHUB_PATH"] as const;

// The steps strictly BETWEEN the preflight and the apply, byte-pinned
// like the run block itself: the guard's verdict is only as good as
// the merged document staying untouched until the apply reads it, so
// the gap is part of the guarded shape (an intervening step could
// rewrite $RUNNER_TEMP/merged-settings.yml after validation). The
// gap is exactly the stood-down notice settings-hidden-step-notices
// requires.
const PREFLIGHT_GAP_STEPS: Record<string, { if: string; run: string }[]> = {
  ".github/workflows/settings-repos.yml": [
    {
      if: "steps.labels.outputs.not_applicable == 'true'",
      run: 'echo "::notice::label preflight stood down for ${{ matrix.repo }}: ${{ steps.labels.outputs.reason }}"\n',
    },
  ],
};

// Step keys the preflight may carry - an ALLOWLIST, because the
// reroute class is open-ended: `shell: true {0}` runs `true <script>`
// (the script never executes), and working-directory:,
// continue-on-error:, or a future runner key softens or reroutes the
// guard the same way while the byte-pinned run block reads intact.
export const PREFLIGHT_STEP_KEYS: Record<string, ReadonlySet<string>> = {
  ".github/workflows/settings-repos.yml": new Set(["name", "id", "if", "env", "run"]),
};

/** The whole per-job judgment for the settings-label-preflight rule,
 *  pure over a parsed job (and its workflow document, for the
 *  inherited-state checks) so the suite can prove every comparison
 *  fires on a synthetic mutation (the live-file mutations cannot
 *  isolate them). Returns the number of settings-apply steps seen (the
 *  rule's anchor count) alongside the mismatches. */
export function labelPreflightJobMismatches(
  rel: string,
  jobName: string,
  job: Record<string, unknown>,
  workflow: Record<string, unknown> = {},
): { applies: number; mismatches: Mismatch[] } {
  if (!(rel in PREFLIGHT_EXPECTED_RUN)) {
    throw new Error(`labelPreflightJobMismatches: no pinned preflight shape for ${rel}`);
  }
  const mismatches: Mismatch[] = [];
  const raw = job.steps;
  if (!Array.isArray(raw)) return { applies: 0, mismatches };
  const steps = raw.map(asMapping);
  const applyAts = steps.flatMap((step, index) => (isApplyStep(step) ? [index] : []));
  if (applyAts.length === 0) return { applies: 0, mismatches };
  // Exactly ONE apply step: the gap pin below guards the stretch from
  // the preflight to THE apply, and a second invocation of the settings
  // action would sit outside that guarded stretch by construction.
  if (applyAts.length > 1) {
    mismatches.push({
      file: rel,
      expected: `exactly one settings apply step in job '${jobName}'`,
      got: `${applyAts.length} steps use the action - a second apply escapes the pinned preflight-to-apply gap`,
    });
  }
  // Inherited execution state: a workflow- or job-level defaults.run
  // reroutes every run step exactly like a step-level shell:, and a
  // workflow/job env var (BASH_ENV) injects like a step one - the
  // step-level allowlists alone would miss both.
  if ("defaults" in workflow) {
    mismatches.push({
      file: rel,
      expected:
        "no workflow-level defaults: (a defaults.run shell or working-directory reroutes every run step around the byte-pinned run block)",
      got: "a defaults: key on the workflow",
    });
  }
  const workflowEnvKeys = Object.keys(asMapping(workflow.env));
  if (workflowEnvKeys.length > 0) {
    mismatches.push({
      file: rel,
      expected:
        "no workflow-level env: (a workflow env var - BASH_ENV - reaches the preflight's shell like a step one)",
      got: `workflow env key(s) '${workflowEnvKeys.join("', '")}'`,
    });
  }
  if ("defaults" in job) {
    mismatches.push({
      file: rel,
      expected: `no defaults: on job '${jobName}' (a job-level shell or working-directory reroutes every run step around the byte-pinned run block)`,
      got: "a defaults: key on the job",
    });
  }
  for (const key of Object.keys(asMapping(job.env))) {
    if (!PREFLIGHT_JOB_ENV_KEYS[rel].has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned job-level env keys [${[...PREFLIGHT_JOB_ENV_KEYS[rel]].join(", ")}] on ` +
          `job '${jobName}' - a job env var (BASH_ENV) reaches the preflight's shell like a step one`,
        got: `job env key '${key}'`,
      });
    }
  }
  for (const key of Object.keys(job)) {
    if (key === "defaults") continue; // the dedicated defaults check above owns it
    if (!PREFLIGHT_APPLY_JOB_KEYS[rel].has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned job keys [${[...PREFLIGHT_APPLY_JOB_KEYS[rel]].join(", ")}] on job ` +
          `'${jobName}' - any other key (container:, services:, a future runner key) re-homes ` +
          "the execution context underneath every step-level pin",
        got: `job key '${key}'`,
      });
    }
  }
  const runsOn = String(job["runs-on"] ?? "").trim();
  if (runsOn !== PREFLIGHT_APPLY_RUNS_ON) {
    mismatches.push({
      file: rel,
      expected:
        `runs-on: ${PREFLIGHT_APPLY_RUNS_ON} on job '${jobName}' (the pinned hosted runner - a ` +
        "self-hosted label is a different machine wearing the same workflow text)",
      got: runsOn === "" ? "no runs-on" : `runs-on: ${runsOn}`,
    });
  }
  for (const [index, step] of steps.entries()) {
    const runText = String(step.run ?? "");
    for (const token of PREFLIGHT_FORBIDDEN_RUN_TOKENS) {
      if (runText.includes(token)) {
        mismatches.push({
          file: rel,
          expected:
            `no ${token} in any run block of job '${jobName}' (persisted environment poisons later ` +
            "steps: a BASH_ENV hook or a counterfeit PATH entry reroutes the guard while its pinned run block reads intact)",
          got: `step ${index + 1} ('${String(step.name ?? step.id ?? "unnamed")}') mentions ${token}`,
        });
      }
    }
  }
  const preflightAts = steps.flatMap((step, index) =>
    invokesPreflightLeg(String(step.run ?? "")) ? [index] : [],
  );
  if (preflightAts.length === 0) {
    const mentioned = steps.some((step) => {
      const run = String(step.run ?? "");
      return run.includes(LAYER_STEP_SCRIPT) || run.includes(PREFLIGHT_SCRIPT);
    });
    mismatches.push({
      file: rel,
      expected: `a step running the ${LAYER_STEP_SCRIPT} labels leg in job '${jobName}' before its settings apply`,
      got: mentioned
        ? "a mention, but no labels-leg invocation - an unexpected invocation form does not satisfy the pin; use the landed shape"
        : "no such step - the apply would delete labels the target still references, unchecked",
    });
    return { applies: applyAts.length, mismatches };
  }
  if (preflightAts.length > 1) {
    mismatches.push({
      file: rel,
      expected: `exactly one label-preflight step in job '${jobName}'`,
      got: `${preflightAts.length} steps invoke it - a second site escapes the pinned guard shape`,
    });
  }
  const preflight = steps[preflightAts[0]];
  const preflightIf = String(preflight.if ?? "").trim();
  const preflightEnv = asMapping(preflight.env);
  // The gap between the preflight and the apply is part of the guarded
  // shape: the verdict is only as good as the merged document staying
  // untouched until the apply reads it.
  const firstApply = Math.min(...applyAts);
  if (preflightAts[0] < firstApply) {
    const gap = steps.slice(preflightAts[0] + 1, firstApply);
    const expectedGap = PREFLIGHT_GAP_STEPS[rel];
    if (gap.length !== expectedGap.length) {
      mismatches.push({
        file: rel,
        expected:
          `exactly ${expectedGap.length} step(s) between the preflight and the apply (the pinned ` +
          "gap - an intervening step could rewrite the merged document after the guard validated it)",
        got: `${gap.length} step(s)`,
      });
    } else {
      gap.forEach((step, index) => {
        const pinned = expectedGap[index];
        const keys = Object.keys(step).sort().join(", ");
        if (keys !== "if, name, run") {
          mismatches.push({
            file: rel,
            expected: `gap step ${index + 1} carrying exactly the keys [if, name, run] (the pinned notice shape)`,
            got: `keys [${keys}]`,
          });
        } else if (
          String(step.if ?? "").trim() !== pinned.if ||
          String(step.run ?? "") !== pinned.run
        ) {
          mismatches.push({
            file: rel,
            expected: `gap step ${index + 1} matching the pinned stood-down notice (PREFLIGHT_GAP_STEPS: run byte-for-byte, if compared after trimming)`,
            got: "a drifted gap step",
          });
        }
      });
    }
  }
  for (const key of Object.keys(preflight)) {
    if (!PREFLIGHT_STEP_KEYS[rel].has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned step keys [${[...PREFLIGHT_STEP_KEYS[rel]].join(", ")}] on the preflight ` +
          "step - any other key (shell:, working-directory:, continue-on-error:) reroutes or softens " +
          "the guard while the byte-pinned run block reads intact",
        got: `step key '${key}'`,
      });
    }
  }
  const allowedEnv = preflightEnvNames(rel);
  for (const key of Object.keys(preflightEnv)) {
    if (!allowedEnv.has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned env keys [${[...allowedEnv].join(", ")}] on the preflight step - ` +
          "an env var outside the census (BASH_ENV) can inject execution the run pin cannot see",
        got: `env key '${key}'`,
      });
    }
  }
  for (const [key, value] of Object.entries(PREFLIGHT_STEP_ENV_PINS[rel])) {
    const actual = String(preflightEnv[key] ?? "").trim();
    if (actual !== value) {
      mismatches.push({
        file: rel,
        expected: `preflight env ${key}: ${JSON.stringify(value)} (the render's published commit - the fetched row's reference files are read at it)`,
        got: actual === "" ? "no such env value" : actual,
      });
    }
  }
  // EVERY apply step, like the skip-gate rule: a second invocation of
  // the settings action must not borrow the first one's guard.
  for (const applyAt of applyAts) {
    if (preflightAts[0] > applyAt) {
      mismatches.push({
        file: rel,
        expected: `the label preflight BEFORE the settings apply step (job '${jobName}')`,
        got: "the preflight runs after the apply - the deletions it exists to refuse have already happened",
      });
    }
    const applyIf = String(steps[applyAt].if ?? "").trim();
    // TEXT parity only, deliberately: this proves the guard and the apply
    // share ONE condition; the condition's VALUE is the sibling
    // settings-apply-skip-gate rule's job, so a JOINT drift fires there, and
    // re-pinning it here would double-report every legitimate edit. The split
    // is load-bearing defense in depth: retiring the sibling (its roster entry
    // makes that loud) would leave this parity satisfiable by any condition.
    if (preflightIf !== applyIf) {
      mismatches.push({
        file: rel,
        expected:
          `the label preflight's condition identical (after trimming) to the apply step's ` +
          `(${JSON.stringify(applyIf)}) - the guard must run exactly when the guarded apply runs`,
        got: preflightIf === "" ? "no condition at all" : preflightIf,
      });
    }
    const applyWith = asMapping(steps[applyAt].with);
    const census = PREFLIGHT_APPLY_WITH[rel];
    for (const key of Object.keys(applyWith)) {
      if (!(key in census)) {
        mismatches.push({
          file: rel,
          expected:
            `only the pinned apply inputs [${Object.keys(census).join(", ")}] - an input outside ` +
            "the census changes what the apply does in a way the guard cannot mirror",
          got: `with key '${key}'`,
        });
      }
    }
    for (const [key, expectation] of Object.entries(census)) {
      const withValue = String(applyWith[key] ?? "").trim();
      if ("pinnedElsewhere" in expectation) {
        if (!(key in applyWith)) {
          mismatches.push({
            file: rel,
            expected: `the apply input with.${key} present (its value is pinned by another rule)`,
            got: "no such input",
          });
        }
        continue;
      }
      if ("literal" in expectation) {
        if (withValue !== expectation.literal) {
          mismatches.push({
            file: rel,
            expected: `the apply input with.${key}: ${JSON.stringify(expectation.literal)} (the pinned census value)`,
            got: withValue === "" ? "no such input" : withValue,
          });
        }
        continue;
      }
      const envValue = String(preflightEnv[expectation.parity] ?? "").trim();
      if (withValue !== expectation.value) {
        mismatches.push({
          file: rel,
          expected:
            `the apply input with.${key}: ${JSON.stringify(expectation.value)} (the census's ` +
            "context-stable expression - text parity alone can evaluate differently between a run step's env and a uses step's with)",
          got: withValue === "" ? "no such input" : withValue,
        });
      }
      if (envValue !== expectation.value) {
        mismatches.push({
          file: rel,
          expected:
            `preflight env ${expectation.parity}: ${JSON.stringify(expectation.value)} (the same ` +
            `pinned expression the apply's with.${key} carries - the guard must judge under exactly the configuration the apply runs with)`,
          got: envValue === "" ? "no such env value" : envValue,
        });
      }
    }
  }
  if (String(preflight.run ?? "") !== PREFLIGHT_EXPECTED_RUN[rel]) {
    mismatches.push({
      file: rel,
      expected:
        "the preflight step's run block byte-identical to the landed shape (the PREFLIGHT_EXPECTED_RUN pin) - " +
        "anything else is unauditable by a textual rule; a deliberate edit updates the pin in the same change",
      got: "a drifted run block",
    });
  }
  if (rel === ".github/workflows/settings-repos.yml" && String(preflight.id ?? "") !== "labels") {
    mismatches.push({
      file: rel,
      expected:
        "id: labels on the preflight step (the stood-down notice reads steps.labels.outputs.*)",
      got: preflight.id === undefined ? "no id" : `id: ${String(preflight.id)}`,
    });
  }
  return { applies: applyAts.length, mismatches };
}

/** One workflow file's whole judgment: every job through
 *  labelPreflightJobMismatches, plus the anchor-lost throw - a parsed
 *  document with no settings-apply step anywhere means the rule's
 *  subject vanished, which must never pass silently. Exported so the
 *  suite can prove the throw fires on an apply-free document. */
export function labelPreflightFileMismatches(
  rel: string,
  workflow: Record<string, unknown>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  let applies = 0;
  for (const [jobName, job] of Object.entries(asMapping(workflow.jobs))) {
    const result = labelPreflightJobMismatches(rel, jobName, asMapping(job), workflow);
    applies += result.applies;
    mismatches.push(...result.mismatches);
  }
  if (applies === 0) throw new Error(`${rel}: no github-settings-as-code step - anchor lost`);
  return mismatches;
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const labelPreflightRules: Rule[] = [
  {
    // Referenced-label preflight: the FAIL-CLOSED guard the apply runs before
    // github-settings-as-code's reconciliation DELETES labels. Dropping,
    // reordering, softening, or re-aiming the step is silent (the apply stays
    // green while referenced-label deletions go unchecked, or checked against
    // the WRONG repository), so the whole landed shape is pinned: the
    // workflow step down to its byte-identical run line and gap, and the
    // argv the layer step builds for the guard - a function of the
    // workflow-provided mode and env only, never of repository content.
    // settings-hidden-step-notices pins the notice compensating for this
    // step's hidden output.
    name: "settings-label-preflight",
    run: () => {
      const rel = ".github/workflows/settings-repos.yml";
      return [
        ...labelPreflightFileMismatches(rel, asRecord(parseYaml(read(rel)), rel)),
        ...labelPreflightArgvMismatches(),
      ];
    },
  },
];
