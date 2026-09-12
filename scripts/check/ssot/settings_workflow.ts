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

/** repo-platform's own overlay: the writer renders the root
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

/** An empty repos input is the action's single-repo mode, so the apply is gated on the selector's non-empty output.
 *  The with: block is matched whole: `repository`, `settings-file`, `defaults-file`, or `repos-dir` would apply a document
 *  other than each target's own rendered file. */
export function settingsApplyInputMismatches(text: string): Mismatch[] {
  const rel = SETTINGS_WORKFLOW;
  const steps = stepsOf(text, rel);
  const selectors = steps.filter((step) => String(step.run ?? "").trim() === SETTINGS_SELECTOR);
  if (selectors.length !== 1)
    throw new Error(`${rel}: no single target-selection step - anchor lost`);
  const applies = steps.filter((step) =>
    String(step.uses ?? "").includes("github-settings-as-code"),
  );
  if (applies.length === 0)
    throw new Error(`${rel}: no github-settings-as-code step - anchor lost`);
  const mismatches: Mismatch[] = [];
  if (applies.length !== 1) {
    mismatches.push({
      file: rel,
      expected: "one github-settings-as-code step (one repos-mode apply over the selected targets)",
      got: `${applies.length} steps`,
    });
  }
  const selectId = String(selectors[0].id ?? "");
  const gate = `steps.${selectId}.outputs.repos != ''`;
  // The version comment is not in the parsed step, so the pin is read off
  // the document's own `uses` scalar (value plus trailing comment): text
  // elsewhere in the file can neither satisfy nor hide it.
  const usesLine = `uses: ${SETTINGS_ACTION_USES}`;
  const pins = applyUsesPins(text);
  if (pins.length !== applies.length) {
    mismatches.push({
      file: rel,
      expected: `${usesLine} as a plain scalar on every apply step`,
      got: `${pins.length} readable pin(s) for ${applies.length} step(s) (an alias or a non-scalar uses)`,
    });
  }
  for (const pin of pins) {
    if (pin !== SETTINGS_ACTION_USES) mismatches.push({ file: rel, expected: usesLine, got: pin });
  }
  const wanted = {
    token: "${{ secrets.REPO_PLATFORM_TOKEN }}",
    mode: "${{ inputs.check_only && 'check' || 'apply' }}",
    repos: `\${{ steps.${selectId}.outputs.repos }}`,
    "private-repos": "redact",
    "private-report": "issue",
    "on-missing-permission": "fail",
  };
  for (const step of applies) {
    if (String(step.if ?? "").trim() !== gate) {
      mismatches.push({
        file: rel,
        expected: `the apply step gated on if: ${gate}`,
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
    // handed, so what it is handed is load-bearing: the selector's output
    // and nothing else, each target's own rendered document, under the
    // tagged pin.
    name: "settings-apply-input",
    run: () => settingsApplyInputMismatches(read(SETTINGS_WORKFLOW)),
  },
];
