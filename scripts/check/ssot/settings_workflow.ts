// Rules over the settings layers and settings-repos.yml: the starter's
// identity keys, the pinned read and apply steps, hide-details wiring, and
// step-output gates across every workflow.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  identityKeyIssues,
  loadOverrideLayer,
} from "../../../.github/scripts/fleet/merge_settings_layers.ts";
import { normalizeJinja, placeholderJinja } from "../../lib/jinja_subset.ts";
import {
  intersectionCarriesType,
  propertyAssignmentCarries,
  templateCarries,
} from "../../lib/ts_extract.ts";
import type { Mismatch } from "./comparison.ts";
import { asRecord, jinjaVars, REPO_ROOT, read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  "continue-on-error"?: boolean | string;
}

/** Every step of every job in a workflow, parsed. Rules about step
 *  conditions read this rather than the file's text: a matching string in
 *  a comment, or on some other step, must not satisfy them. */
function workflowSteps(rel: string): WorkflowStep[] {
  const doc = asRecord(parseYaml(read(rel)), rel);
  const jobs = asRecord(doc.jobs ?? {}, `${rel} jobs`);
  const steps: WorkflowStep[] = [];
  for (const job of Object.values(jobs)) {
    const list = asRecord(job ?? {}, `${rel} job`).steps;
    if (!Array.isArray(list)) continue;
    for (const step of list) steps.push(asRecord(step, `${rel} step`) as WorkflowStep);
  }
  return steps;
}

/** The unsafe term of a step condition, or null when every term is safe.
 *  An unrun step's ABSENT output compares as the number 0 in Actions, so
 *  only `== '<non-zero literal>'` and `!= ''` cannot be satisfied by one.
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

/** unsafeStepCondition over a workflow's steps, exempting FAIL steps (a
 *  bare `exit <non-zero>` last line, no continue-on-error): a gate that
 *  opens on an absent output there turns the job red, which is the point. */
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

/** The identity keys the settings starter seeds (description,
 *  homepage, topics, private); the key list lives with the merge dialect
 *  (identityKeyIssues) - this wrapper applies the same contract to
 *  repo-platform's own .github/settings.yml so the two checkers cannot
 *  drift apart. */
export function settingsIdentityMismatches(repository: Record<string, unknown>): Mismatch[] {
  return identityKeyIssues(repository).map((issue) => ({
    file: `.github/settings.yml repository.${issue.key}`,
    expected: issue.expected,
    got: issue.got,
  }));
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const settingsWorkflowRules: Rule[] = [
  {
    // The base settings starter and repo-platform's own .github/settings.yml
    // are the two independently-authored repo layers this repo controls;
    // the managed baseline document (.github/settings-baseline.yml) is the
    // single home of the fleet-generic content, so no baseline pair exists
    // to compare here. This rule pins what the layers must declare: the
    // starter seeds all four identity keys, repo-platform's own file
    // declares them with valid shapes, and its hand-written non-bypassable
    // override stays byte-equivalent to the baseline entry it replaces
    // wholesale (a drifted override would silently weaken the ruleset the
    // baseline promises).
    name: "settings-starter",
    run: () => {
      const mismatches: Mismatch[] = [];
      const vars = jinjaVars();
      const starter = asRecord(
        parseYaml(
          placeholderJinja(normalizeJinja(read("templates/base/.github/settings.yml.jinja"), vars)),
        ),
        "settings.yml.jinja",
      );
      const starterRepository = asRecord(starter.repository, "settings.yml.jinja repository");
      for (const key of ["description", "homepage", "topics", "private"]) {
        if (!(key in starterRepository)) {
          mismatches.push({
            file: "templates/base/.github/settings.yml.jinja",
            expected: `repository.${key} seeded from the copier answers`,
            got: "missing - the starter must declare all four identity keys",
          });
        }
      }
      // The starter is a repo layer: a labels or rulesets section in it
      // would seed every new repo with a shadowing copy of baseline
      // entries (frozen at render time, overriding baseline evolution).
      for (const section of ["labels", "rulesets"]) {
        if (starter[section] !== undefined) {
          mismatches.push({
            file: "templates/base/.github/settings.yml.jinja",
            expected: `no ${section} section (the managed baseline supplies it; the starter only shows commented examples)`,
            got: "declared",
          });
        }
      }

      const own = asRecord(parseYaml(read(".github/settings.yml")), ".github/settings.yml");
      mismatches.push(
        ...settingsIdentityMismatches(asRecord(own.repository, ".github/settings.yml repository")),
      );

      // The fleet protection rulesets live in the override layer, which
      // merges ABOVE every repo layer - so a repo (this one included)
      // redeclaring one would be silently overridden. Assert the override
      // owns them and no repo layer duplicates them.
      const override = loadOverrideLayer();
      const overrideRulesets = (override.rulesets ?? []) as Record<string, unknown>[];
      for (const name of ["main", "non-bypassable"]) {
        if (!overrideRulesets.some((ruleset) => ruleset.name === name)) {
          throw new Error(`.github/settings-override.yml: no ${name} ruleset - anchor lost`);
        }
        if ((own.rulesets as Record<string, unknown>[] | undefined)?.some((r) => r.name === name)) {
          mismatches.push({
            file: ".github/settings.yml",
            expected: `no '${name}' ruleset (the override layer supplies it and wins over this file)`,
            got: "declared, which the merge silently overrides",
          });
        }
      }
      return mismatches;
    },
  },
  {
    name: "settings-read-pin",
    run: () => {
      // The unit tests can prove factsFromFetch forwards one ref and that
      // the CLI refuses an unpinned fetch. They cannot see the TRANSPORT
      // or the workflow, so those are pinned here: the ref has to reach
      // the API URL, and the fetch call has to carry the render's output.
      const mismatches: Mismatch[] = [];
      const render = read(".github/scripts/fleet/render_managed_settings.ts");
      if (!templateCarries(render, "contents/${path}?ref=${ref}")) {
        mismatches.push({
          file: ".github/scripts/fleet/render_managed_settings.ts",
          expected: "the contents URL carries ?ref=, or every fact reads the moving branch",
          got: "no ?ref= on the fetch URL",
        });
      }
      const merge = read(".github/scripts/fleet/merge_settings_layers.ts");
      if (!templateCarries(merge, "contents/.github/settings.yml?ref=${ref}")) {
        mismatches.push({
          file: ".github/scripts/fleet/merge_settings_layers.ts",
          expected: "the repo-layer URL carries ?ref=",
          got: "no ?ref= on the repo-layer fetch",
        });
      }
      const workflow = read(".github/workflows/settings-repos.yml").replace(/\\[ \t]*\n\s*/g, " ");
      if (
        !/--repo-fetch [^\n]*--repo-ref "\$\{\{ steps\.render\.outputs\.ref \}\}"/.test(workflow)
      ) {
        mismatches.push({
          file: ".github/workflows/settings-repos.yml",
          expected: "every --repo-fetch passes the render step's published ref",
          got: "a fetch without the pinned ref",
        });
      }
      // The operator row reads its own checkout; fetching it would race
      // against the facts the render took from that same working tree.
      if (!/--repo-file \.github\/settings\.yml/.test(workflow)) {
        mismatches.push({
          file: ".github/workflows/settings-repos.yml",
          expected: "the operator row merges from its checkout (--repo-file)",
          got: "the operator row fetches",
        });
      }
      return mismatches;
    },
  },
  {
    name: "settings-hide-details",
    run: () => {
      // The layer render and the merge run BEFORE the settings action, so
      // the action's own redaction cannot cover their output, and both
      // quote repo-owned content on their diagnostic paths. The row's
      // private flag must therefore reach them: it has to ride the matrix
      // AND be handed to both steps, which pass it to run_hidden.ts. This
      // was dropped once already, with a comment explaining why it was
      // safe - it was not, so the invariant is pinned rather than
      // commented.
      const mismatches: Mismatch[] = [];
      const matrix = read(".github/scripts/fleet/build_settings_matrix.ts");
      if (
        !intersectionCarriesType(matrix, "RedactionState") ||
        !propertyAssignmentCarries(matrix, "private", "true") ||
        !propertyAssignmentCarries(matrix, "verify", "row.verify")
      ) {
        mismatches.push({
          file: ".github/scripts/fleet/build_settings_matrix.ts",
          expected:
            "the matrix Target carries the row's RedactionState (redact.ts): a private arm setting private: true and copying row.verify",
          got: "the redaction pair is not on the matrix",
        });
      }
      const workflow = read(".github/workflows/settings-repos.yml");
      // Per INVOCATION, not per count: there are two render call sites
      // (operator and target), so counting matches passed even with a
      // wrapper removed - which is the exact regression this rule exists
      // to catch. Fold continuations first, then require every call of
      // either script to sit behind its own run_hidden wrapper. The
      // freshness recheck is covered too: its moved warning quotes commit
      // shas and its resolver errors name the target's default branch.
      const flat = workflow.replace(/\\[ \t]*\n/g, " ").replace(/\s+/g, " ");
      for (const script of [
        "render_managed_settings",
        "merge_settings_layers",
        "check_target_fresh",
      ]) {
        const calls =
          flat.match(new RegExp(`bun \\.github/scripts/fleet/${script}\\.ts`, "g")) ?? [];
        const wrapped =
          flat.match(
            new RegExp(
              `run_hidden\\.ts "settings [a-z]+" -- bun \\.github/scripts/fleet/${script}\\.ts`,
              "g",
            ),
          ) ?? [];
        if (calls.length === 0 || wrapped.length !== calls.length) {
          mismatches.push({
            file: ".github/workflows/settings-repos.yml",
            expected: `every ${script}.ts call wrapped in run_hidden.ts (${calls.length} call(s))`,
            got: `${wrapped.length} wrapped`,
          });
        }
      }
      if (!/^\s+HIDE_DETAILS: \$\{\{ matrix\.private \}\}$/m.test(workflow)) {
        mismatches.push({
          file: ".github/workflows/settings-repos.yml",
          expected: "the apply job takes HIDE_DETAILS from the matrix row",
          got: "no such env binding",
        });
      }
      if (!flat.includes("failure_issue.ts deliver")) {
        mismatches.push({
          file: ".github/workflows/settings-repos.yml",
          expected:
            "a deliver step for hidden diagnostics (run_hidden captures them privately; without delivery the detail dies with the runner)",
          got: "no failure_issue.ts deliver step",
        });
      }
      // Per STEP, not per flattened file: a title binding or a condition
      // sitting on some unrelated step would satisfy a whole-file search.
      // Steps are the "- name:" blocks of the apply job.
      const steps = new Map<string, string>();
      for (const block of workflow.split(/\n {6}- name: /).slice(1)) {
        const name = block.slice(0, block.indexOf("\n"));
        steps.set(name.trim(), block);
      }
      const step = (name: string, needs: [RegExp, string][]) => {
        const block = steps.get(name);
        if (block === undefined) {
          mismatches.push({
            file: ".github/workflows/settings-repos.yml",
            expected: `a step named "${name}"`,
            got: "no such step",
          });
          return;
        }
        for (const [pattern, what] of needs) {
          if (!pattern.test(block)) {
            mismatches.push({
              file: `.github/workflows/settings-repos.yml step "${name}"`,
              expected: what,
              got: "missing",
            });
          }
        }
      };
      const settingsTitle = /REPORT_TITLE: \$\{\{ env\.SETTINGS_REPORT_TITLE \}\}/;
      step("Deliver hidden failure diagnostics", [
        [/failure_issue\.ts deliver/, "the deliver call"],
        [settingsTitle, "the settings-specific report title"],
        [/if: failure\(\)/, "a failure() condition"],
      ]);
      // Deliver without resolve leaves the report open after a recovered
      // run, and a shared title would let the sync workflow's green run
      // close a report the settings apply is still failing on.
      step("Resolve the settings failure report", [
        [/failure_issue\.ts resolve/, "the resolve call"],
        [settingsTitle, "the settings-specific report title"],
        [/success\(\)/, "a success() condition"],
        // A moved target was never checked, so a green job alone must not
        // close its open report.
        [/steps\.apply\.outcome == .success./, "a check that the apply actually ran"],
      ]);
      // OUTSIDE the hidden capture, or a hide-details target is skipped
      // with a green job and no signal at all.
      step("Report a skipped target", [
        [/steps\.merge\.outputs\.skipped == 'true'/, "a condition on the merge step's output"],
        [/::notice::/, "a public notice"],
      ]);
      // The whole point of that step is being OUTSIDE the capture, so the
      // wrapper is checked as a forbidden token, not a negated pattern.
      const skipStep = steps.get("Report a skipped target");
      if (skipStep?.includes("run_hidden")) {
        mismatches.push({
          file: '.github/workflows/settings-repos.yml step "Report a skipped target"',
          expected: "the notice stays outside run_hidden, or the skip has no public signal",
          got: "wrapped in run_hidden",
        });
      }
      return mismatches;
    },
  },
  {
    name: "settings-apply-skip-gate",
    run: () => {
      // The apply DELETES labels the merged document does not declare, so
      // every step condition guarding it is load-bearing: a target that
      // dropped the module writes no baseline, one with no settings.yml of
      // its own writes no merged document, and a target whose branch moved
      // has a stale one. No unit test can see a workflow, so the shape is
      // asserted here - on the parsed steps, not on the file's text, so a
      // matching string in a comment or an unrelated step cannot satisfy it.
      const mismatches: Mismatch[] = [];
      const expected: Record<string, string> = {
        merge: "steps.render.outputs.skipped == 'false'",
        freshness:
          "steps.render.outputs.skipped == 'false' && steps.merge.outputs.skipped == 'false'",
        apply: "steps.freshness.outputs.moved == 'false'",
      };
      {
        const rel = ".github/workflows/settings-repos.yml";
        const steps = workflowSteps(rel);
        for (const [id, condition] of Object.entries(expected)) {
          // EVERY apply step, not the first: a second, ungated
          // invocation of the settings action would otherwise pass.
          const matched =
            id === "apply"
              ? steps.filter((s) => String(s.uses ?? "").includes("github-settings-as-code"))
              : steps.filter((s) => s.id === id);
          if (matched.length === 0) {
            mismatches.push({ file: rel, expected: `a settings ${id} step`, got: "no such step" });
            continue;
          }
          for (const step of matched) {
            const actual = String(step.if ?? "").trim();
            if (actual !== condition) {
              mismatches.push({
                file: rel,
                expected: `the ${id} step condition ${condition}`,
                got: actual === "" ? "no condition at all" : actual,
              });
            }
          }
        }
      }
      return mismatches;
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
    // The apply must hand github-settings-as-code the MERGED document. A
    // one-line regression to managed-settings.yml ships a baseline-only
    // apply - the exact document the merge pipeline exists to never
    // produce, because the action's label reconciliation would delete
    // every label the repository declares for itself - and every other
    // gate stays green while it does. Self-contained on purpose: the
    // workflow is parsed right here, leaning on no shared workflow
    // helpers.
    name: "settings-apply-merged-input",
    run: () => {
      const mismatches: Mismatch[] = [];
      const wanted = "${{ runner.temp }}/merged-settings.yml";
      const mapping = (value: unknown): Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      {
        const rel = ".github/workflows/settings-repos.yml";
        const jobs = mapping(mapping(parseYaml(read(rel))).jobs);
        const applySteps: Record<string, unknown>[] = [];
        for (const job of Object.values(jobs)) {
          const steps = mapping(job).steps;
          if (!Array.isArray(steps)) continue;
          for (const raw of steps) {
            const step = mapping(raw);
            if (String(step.uses ?? "").includes("github-settings-as-code")) {
              applySteps.push(step);
            }
          }
        }
        if (applySteps.length === 0) {
          throw new Error(`${rel}: no github-settings-as-code step - anchor lost`);
        }
        for (const step of applySteps) {
          const settingsFile = String(mapping(step.with)["settings-file"] ?? "");
          if (settingsFile !== wanted) {
            mismatches.push({
              file: rel,
              expected: `the apply step reads settings-file: ${wanted}`,
              got: settingsFile === "" ? "no settings-file input" : settingsFile,
            });
          }
        }
      }
      return mismatches;
    },
  },
  {
    // Every run_hidden-wrapped step in settings-repos.yml must be
    // followed by a PUBLIC ::notice:: step that fires on one of the
    // wrapped step's own outputs. The capture swallows a wrapped step's
    // success output - warnings included - for a hide-details target, so
    // without a compensating notice its skip is a green job with no
    // signal at all. DERIVED from the workflow rather than pinned per
    // step: this gap was reintroduced three times one step at a time (the
    // merge notice, then the freshness wrap, then the notice condition
    // missing the freshness clause), so a fourth wrapped script fails
    // here until it gets its notice instead of repeating the cycle.
    // Order is part of the requirement - the notice must sit AFTER the
    // wrapped step, or it reads outputs that do not exist yet.
    // Self-contained like the neighbouring settings rules.
    name: "settings-hidden-step-notices",
    run: () => {
      const mismatches: Mismatch[] = [];
      const rel = ".github/workflows/settings-repos.yml";
      const mapping = (value: unknown): Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const jobs = mapping(mapping(parseYaml(read(rel))).jobs);
      let wrapped = 0;
      for (const [jobName, job] of Object.entries(jobs)) {
        const steps = mapping(job).steps;
        if (!Array.isArray(steps)) continue;
        const parsed = steps.map(mapping);
        parsed.forEach((step, index) => {
          if (!String(step.run ?? "").includes("run_hidden.ts")) return;
          wrapped++;
          const id = String(step.id ?? "");
          if (id === "") {
            mismatches.push({
              file: rel,
              expected: `an id on the run_hidden-wrapped step ${JSON.stringify(String(step.name ?? "?"))} (job '${jobName}')`,
              got: "no id - a compensating notice cannot reference the step's outcome",
            });
            return;
          }
          // Positive equality against 'true', the one output test an
          // unrun step cannot satisfy (unsafeStepCondition's rule). The
          // id is escaped so an exotic step id cannot broaden the match.
          const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const fires = new RegExp(`steps\\.${escaped}\\.outputs\\.[\\w-]+ == 'true'`);
          const compensated = parsed.slice(index + 1).some((later) => {
            const laterRun = String(later.run ?? "");
            return (
              !laterRun.includes("run_hidden") &&
              laterRun.includes("::notice::") &&
              fires.test(String(later.if ?? ""))
            );
          });
          if (!compensated) {
            mismatches.push({
              file: rel,
              expected:
                `a public ::notice:: step AFTER the hidden '${id}' step whose condition ` +
                `carries steps.${id}.outputs.<name> == 'true' - the capture swallows the ` +
                "step's own warnings, so its skip would otherwise be a green job with no signal",
              got: "no such step",
            });
          }
        });
      }
      if (wrapped === 0) throw new Error(`${rel}: no run_hidden-wrapped steps - anchor lost`);
      return mismatches;
    },
  },
];
