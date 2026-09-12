// The pr-title module's natively-required check at its three sources: the
// workflow's trigger shape and job id, the baseline's disabled ruleset, and
// the module settings layer's enforcement flip.

import { parse as parseYaml } from "yaml";
import { canonical, type Mismatch } from "./comparison.ts";
import { asRecord, read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The pr-title module's managed workflow and settings layer, as the writer copies them. */
export const PR_TITLE_WORKFLOW = "files/pr-title/.github/workflows/pr-title.yml";
export const PR_TITLE_LAYER = "files/pr-title/settings.yml";

/** The pr-title module's natively-required check, pinned at its three sources.
 *  The workflow runs on every judged event PLUS synchronize (a required check
 *  must exist at the PR's NEWEST head, or the merge box waits forever), its job
 *  id is the ruleset's check-run name, and the semantic-title action is the one
 *  unconditional step (a replaced step is a green no-op). The BASELINE holds the
 *  ruleset DISABLED, context pinned to the GitHub Actions app (integration_id
 *  15368), so deselection heals via the ordinary apply; the MODULE layer holds
 *  only the enforcement flip, in its own ruleset (a same-type rule REPLACES). */
export function prTitleWorkflowMismatches(
  workflowText: string,
  baselineText: string,
  moduleLayerText: string,
): Mismatch[] {
  const wfRel = PR_TITLE_WORKFLOW;
  const baselineRel = "files/settings/baseline.yml";
  const moduleRel = PR_TITLE_LAYER;
  const mismatches: Mismatch[] = [];
  const lines = workflowText.split("\n");
  const pins: readonly [string, string][] = [
    ["on:", "the trigger block"],
    ["  pull_request:", "the check judges pull requests"],
    [
      "    types: [opened, edited, reopened, synchronize]",
      "opened/edited/reopened re-judge the title; synchronize keeps the required check present at every pushed head",
    ],
    ["  pr-title:", "the job id IS the check-run name the ruleset requires"],
  ];
  for (const [line, why] of pins) {
    const count = lines.filter((candidate) => candidate === line).length;
    if (count !== 1) {
      mismatches.push({
        file: wfRel,
        expected: `the line ${JSON.stringify(line)} exactly once (${why})`,
        got: count === 0 ? "missing" : `${count} occurrences`,
      });
    }
  }
  // A display name would rename the check run away from the required
  // context, and a job- or step-level condition (or a swapped-out step)
  // would leave a required check that judges nothing; the job census
  // above pins the id, these pin the body.
  if (lines.some((line) => /^ {4}name:/.test(line))) {
    mismatches.push({
      file: wfRel,
      expected: "no job-level name: (the check-run name must stay the job id the ruleset requires)",
      got: "a job-level name override",
    });
  }
  if (lines.some((line) => /^ {4,}if:/.test(line))) {
    mismatches.push({
      file: wfRel,
      expected:
        "no job- or step-level if: (a skipped required check reads green while judging nothing)",
      got: "a condition",
    });
  }
  if (lines.some((line) => line.trimStart().startsWith("continue-on-error:"))) {
    mismatches.push({
      file: wfRel,
      expected:
        "no continue-on-error anywhere (a softened judgment step is a green check over a failed validation)",
      got: "a continue-on-error key",
    });
  }
  const actionUses = "      - uses: amannn/action-semantic-pull-request@";
  const actionCount = lines.filter((line) => line.startsWith(actionUses)).length;
  if (actionCount !== 1) {
    mismatches.push({
      file: wfRel,
      expected: `exactly one step whose uses: starts ${JSON.stringify(actionUses.trim())} (the judgment itself - without it the required check is a green no-op)`,
      got: `${actionCount} occurrences`,
    });
  }
  // The baseline's disabled full shape.
  const baseline = asRecord(parseYaml(baselineText), baselineRel);
  const baselineRulesets = (baseline.rulesets ?? []) as Record<string, unknown>[];
  const ruleset = baselineRulesets.find((entry) => entry.name === "pr-title");
  if (ruleset === undefined) {
    mismatches.push({
      file: baselineRel,
      expected:
        "a 'pr-title' ruleset carrying the full shape disabled (the deselection heal: the apply never deletes a whole undeclared ruleset)",
      got: `rulesets: ${baselineRulesets.map((entry) => String(entry.name)).join(", ") || "none"}`,
    });
    return mismatches;
  }
  if (ruleset.enforcement !== "disabled") {
    mismatches.push({
      file: baselineRel,
      expected:
        "enforcement: disabled on the baseline's pr-title ruleset (active here would require the check on every managed repo, module or not)",
      got: String(ruleset.enforcement ?? "missing"),
    });
  }
  // Applicability: an active ruleset requiring the right context still
  // gates nothing if it targets tags or the wrong ref.
  if (ruleset.target !== "branch") {
    mismatches.push({
      file: baselineRel,
      expected: "target: branch on the pr-title ruleset (a tag ruleset gates no merges)",
      got: String(ruleset.target ?? "missing"),
    });
  }
  const refName = asRecord(
    asRecord(ruleset.conditions ?? {}, `${baselineRel} conditions`).ref_name ?? {},
    `${baselineRel} ref_name`,
  );
  if (canonical(refName.include ?? null) !== canonical(["~DEFAULT_BRANCH"])) {
    mismatches.push({
      file: baselineRel,
      expected:
        'conditions.ref_name.include exactly ["~DEFAULT_BRANCH"] (anywhere else the required check gates no default-branch merges)',
      got: canonical(refName.include ?? null),
    });
  }
  if (canonical(refName.exclude ?? null) !== canonical([])) {
    mismatches.push({
      file: baselineRel,
      expected:
        "conditions.ref_name.exclude exactly [] (an exclude entry can carve the default branch back out of the include)",
      got: canonical(refName.exclude ?? null),
    });
  }
  const checksRule = ((ruleset.rules ?? []) as Record<string, unknown>[]).find(
    (rule) => rule.type === "required_status_checks",
  );
  const contexts = (
    (asRecord(checksRule?.parameters ?? {}, `${baselineRel} parameters`).required_status_checks ??
      []) as Record<string, unknown>[]
  ).map((check) => `${String(check.context)}@${String(check.integration_id)}`);
  if (canonical(contexts) !== canonical(["pr-title@15368"])) {
    mismatches.push({
      file: baselineRel,
      expected:
        "exactly one required check, context 'pr-title' pinned to integration_id 15368 (the GitHub Actions app that creates the job's check run)",
      got: contexts.join(", ") || "no required_status_checks rule",
    });
  }
  // The module layer: exactly the enforcement flip. Any other key on the
  // entry could shadow the baseline's shape (a rules list of the same
  // type REPLACES the baseline's rule in the merge).
  const moduleLayer = asRecord(parseYaml(moduleLayerText), moduleRel);
  const moduleEntries = (moduleLayer.rulesets ?? []) as Record<string, unknown>[];
  const flip = moduleEntries.find((entry) => entry.name === "pr-title");
  if (
    moduleEntries.length !== 1 ||
    flip === undefined ||
    canonical(flip) !== canonical({ name: "pr-title", enforcement: "active" })
  ) {
    mismatches.push({
      file: moduleRel,
      expected:
        "exactly one ruleset entry, {name: pr-title, enforcement: active} and nothing else (the shape lives disabled in the baseline; any other key here could shadow it in the merge)",
      got: canonical(moduleLayer.rulesets ?? null),
    });
  }
  return mismatches;
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const prTitleRules: Rule[] = [
  {
    // The pr-title module's natively-required check at its sources
    // (prTitleWorkflowMismatches has the model): the workflow's trigger
    // shape, the job id the ruleset requires, and the module settings
    // layer's pinned context.
    name: "pr-title-workflow",
    run: () =>
      prTitleWorkflowMismatches(
        read(PR_TITLE_WORKFLOW),
        read("files/settings/baseline.yml"),
        read(PR_TITLE_LAYER),
      ),
  },
];
