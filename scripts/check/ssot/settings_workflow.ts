// Rules over the settings layers and settings-repos.yml: the starter's
// identity keys, the pinned read, merge, and apply steps, hide-details
// wiring, and step-output gates across every workflow.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Node } from "ts-morph";
import { parse as parseYaml } from "yaml";
import {
  LAYER_STEPS,
  type LayerStep,
  type LayerStepFacts,
  layerStepArgv,
} from "../../../.github/scripts/fleet/settings_layer_step.ts";
import { loadOverrideLayer } from "../../../.github/scripts/fleet/settings_layers.ts";
import { normalizeJinja, placeholderJinja } from "../../lib/jinja_subset.ts";
import {
  intersectionCarriesType,
  parseTs,
  propertyAssignmentCarries,
  templateCarries,
  unwrapExpression,
} from "../../lib/ts_extract.ts";
import type { Mismatch } from "./comparison.ts";
import { asRecord, jinjaVars, REPO_ROOT, read } from "./inputs.ts";
import { isApplyStep } from "./label_preflight.ts";
import type { Rule } from "./rule_roster.ts";

/** The merged document both settings-action steps meet at: the merge step
 *  writes it, the apply step reads it. */
export const MERGED_SETTINGS_FILE = "${{ runner.temp }}/merged-settings.yml";

/** The merge step's settings-file input: the layers step's published list. */
export const LAYERS_INPUT = "${{ steps.layers.outputs.layers }}";

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

/** The repo scripts a step's text runs (`bun .github/scripts/<path>.ts`),
 *  as repo-relative paths: a step whose logic lives in a script is judged
 *  on what the script does, not on the run line alone. */
function invokedScriptRels(text: string): string[] {
  return [...text.matchAll(/\bbun\s+(\.github\/scripts\/[\w./-]+\.ts)/g)].map((match) => match[1]);
}

/** A repo-relative path's source; injectable so the suite can judge
 *  synthetic workflows against synthetic scripts. */
export type SourceOf = (rel: string) => string;

/** Whether a step runs run_hidden.ts: inline in its text, or through a
 *  script that builds the wrapper's path for an argv (a script that only
 *  IMPORTS run_hidden.ts, for the failure manifest, wraps nothing). */
export function runsHidden(text: string, sourceOf: SourceOf): boolean {
  return (
    text.includes("run_hidden.ts") ||
    invokedScriptRels(text).some((rel) => /join\([^)]*"run_hidden\.ts"\)/.test(sourceOf(rel)))
  );
}

/** Whether a script's TOP-LEVEL action prints a notice: an expression
 *  statement at module level, or inside its `if (import.meta.main)` block,
 *  that IS a call of notice() or of console.log with a ::notice:: literal -
 *  judged on the call node, so a mention inside a short-circuit, a closure,
 *  or a bare string is not a print. A notice inside a helper the entry
 *  point may never reach (failure_issue.ts's owner assignment) is not the
 *  script's action and earns no credit. */
export function printsNoticeAtTopLevel(source: string): boolean {
  const statements = parseTs(source)
    .getStatements()
    .flatMap((statement) => {
      if (!Node.isIfStatement(statement)) return [statement];
      if (statement.getExpression().getText() !== "import.meta.main") return [statement];
      const then = statement.getThenStatement();
      return Node.isBlock(then) ? then.getStatements() : [then];
    });
  return statements.some((statement) => {
    if (!Node.isExpressionStatement(statement)) return false;
    const call = unwrapExpression(statement.getExpression());
    if (!Node.isCallExpression(call)) return false;
    const callee = unwrapExpression(call.getExpression());
    if (Node.isIdentifier(callee)) return callee.getText() === "notice";
    if (!Node.isPropertyAccessExpression(callee) || callee.getText() !== "console.log") {
      return false;
    }
    const first = call.getArguments()[0];
    if (first === undefined) return false;
    const text =
      Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)
        ? first.getLiteralValue()
        : Node.isTemplateExpression(first)
          ? first.getHead().getLiteralText()
          : "";
    return text.startsWith("::notice::");
  });
}

/** Whether a step is a PUBLIC notice step: its run text prints ::notice::
 *  inline, or a script it runs prints one as its top-level action. */
export function printsNotice(run: string, sourceOf: SourceOf): boolean {
  return (
    run.includes("::notice::") ||
    invokedScriptRels(run).some((rel) => printsNoticeAtTopLevel(sourceOf(rel)))
  );
}

/** The settings-hidden-step-notices judgment, pure over the parsed jobs
 *  and a source reader so the suite can prove it fires on a synthetic
 *  mutation: every run_hidden-wrapped step needs an id, and a later
 *  PUBLIC notice step whose condition tests one of its outputs == 'true'
 *  (the one output test an unrun step cannot satisfy; the id is escaped so
 *  an exotic id cannot broaden the match). Order is part of the
 *  requirement: a notice BEFORE the wrapped step reads outputs that do not
 *  exist yet. Returns the wrapped-step count for the anchor check. */
export function hiddenStepNoticeMismatches(
  rel: string,
  jobs: Record<string, unknown>,
  sourceOf: SourceOf,
): { wrapped: number; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  const mapping = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  let wrapped = 0;
  for (const [jobName, job] of Object.entries(jobs)) {
    const steps = mapping(job).steps;
    if (!Array.isArray(steps)) continue;
    const parsed = steps.map(mapping);
    parsed.forEach((step, index) => {
      if (!runsHidden(String(step.run ?? ""), sourceOf)) return;
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
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const fires = new RegExp(`steps\\.${escaped}\\.outputs\\.[\\w-]+ == 'true'`);
      const compensated = parsed.slice(index + 1).some((later) => {
        const laterRun = String(later.run ?? "");
        return (
          !runsHidden(laterRun, sourceOf) &&
          printsNotice(laterRun, sourceOf) &&
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
  return { wrapped, mismatches };
}

/** Placeholder facts for judging a layer leg's argv, every value distinct. */
const LEG_FACTS: LayerStepFacts = {
  target: "o/r",
  operator: false,
  runnerTemp: "/rt",
  pinned: "REF",
  mode: "apply",
};

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

export interface IdentityIssue {
  key: string;
  expected: string;
  got: string;
}

/** Shape hygiene for the identity keys a repo layer declares (the
 *  settings.yml starter seeds all four; the apply never touches an
 *  undeclared key, so drift in a missing one is never healed). */
export function identityKeyIssues(repository: Record<string, unknown>): IdentityIssue[] {
  const issues: IdentityIssue[] = [];
  const got = (value: unknown) => (value === undefined ? "missing" : JSON.stringify(value));
  if (typeof repository.description !== "string" || repository.description === "") {
    issues.push({
      key: "description",
      expected: "a non-empty description string",
      got: got(repository.description),
    });
  }
  if (typeof repository.homepage !== "string") {
    issues.push({
      key: "homepage",
      expected: 'a homepage string ("" declares-and-clears)',
      got: got(repository.homepage),
    });
  }
  const topics = repository.topics;
  if (
    typeof topics !== "string" &&
    !(Array.isArray(topics) && topics.every((t) => typeof t === "string"))
  ) {
    issues.push({
      key: "topics",
      expected: "a declared topics value (string or string list)",
      got: got(topics),
    });
  }
  if (typeof repository.private !== "boolean") {
    issues.push({
      key: "private",
      expected: "an explicit boolean, so the apply manages visibility",
      got: got(repository.private),
    });
  }
  return issues;
}

/** identityKeyIssues over repo-platform's own .github/settings.yml. */
export function settingsIdentityMismatches(repository: Record<string, unknown>): Mismatch[] {
  return identityKeyIssues(repository).map((issue) => ({
    file: `.github/settings.yml repository.${issue.key}`,
    expected: issue.expected,
    got: issue.got,
  }));
}

/** The settings-apply-merged-input judgment over every step that uses the
 *  settings action, pure so the suite can prove each comparison fires:
 *  exactly one merge step (mode: merge, settings-file = the layers step's
 *  list, merged-file = the merged document, no token or repository), and
 *  every apply step reading the merged document as its settings-file. */
export function settingsActionStepMismatches(rel: string, steps: WorkflowStep[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const withOf = (step: WorkflowStep) => step.with ?? {};
  const merges = steps.filter((step) => !isApplyStep(step as Record<string, unknown>));
  if (merges.length !== 1) {
    mismatches.push({
      file: rel,
      expected: "exactly one settings-action step in mode: merge (the fold of the layer list)",
      got: `${merges.length} merge step(s)`,
    });
  }
  for (const merge of merges) {
    const inputs = withOf(merge);
    const expected: Record<string, string> = {
      "settings-file": LAYERS_INPUT,
      "merged-file": MERGED_SETTINGS_FILE,
    };
    for (const [key, value] of Object.entries(expected)) {
      const actual = String(inputs[key] ?? "").trim();
      if (actual !== value) {
        mismatches.push({
          file: rel,
          expected: `the merge step's with.${key}: ${value}`,
          got: actual === "" ? `no ${key} input` : actual,
        });
      }
    }
    for (const key of ["token", "repository"]) {
      if (key in inputs) {
        mismatches.push({
          file: rel,
          expected: `no ${key} input on the merge step (a merge folds files and reaches no repository)`,
          got: `with.${key} present`,
        });
      }
    }
  }
  for (const apply of steps.filter((step) => isApplyStep(step as Record<string, unknown>))) {
    const settingsFile = String(withOf(apply)["settings-file"] ?? "").trim();
    if (settingsFile !== MERGED_SETTINGS_FILE) {
      mismatches.push({
        file: rel,
        expected: `the apply step reads settings-file: ${MERGED_SETTINGS_FILE}`,
        got: settingsFile === "" ? "no settings-file input" : settingsFile,
      });
    }
  }
  return mismatches;
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const settingsWorkflowRules: Rule[] = [
  {
    // The base settings starter and repo-platform's own .github/settings.yml
    // are the two independently-authored repo layers this repo controls; the
    // managed baseline document is the single home of the fleet-generic
    // content, so no baseline pair exists to compare here. The starter must
    // seed all four identity keys, repo-platform's own file must declare them
    // with valid shapes, and its hand-written non-bypassable override must
    // stay byte-equivalent to the baseline entry it replaces wholesale (a
    // drifted override would silently weaken the ruleset the baseline promises).
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
      // the layers script refuses an unpinned fetch. They cannot see the
      // TRANSPORT or the workflow, so those are pinned here: the ref has to
      // reach the API URL, and every later step that reads the target has
      // to carry the layers step's published ref.
      const mismatches: Mismatch[] = [];
      const facts = read(".github/scripts/fleet/settings_facts.ts");
      if (!templateCarries(facts, "contents/${path}?ref=${ref}")) {
        mismatches.push({
          file: ".github/scripts/fleet/settings_facts.ts",
          expected: "the contents URL carries ?ref=, or every fact reads the moving branch",
          got: "no ?ref= on the fetch URL",
        });
      }
      const rel = ".github/workflows/settings-repos.yml";
      const steps = workflowSteps(rel);
      const layersStep = steps.find((step) => step.id === "layers");
      if (layersStep === undefined) throw new Error(`${rel}: no layers step - anchor lost`);
      for (const id of ["freshness", "labels"]) {
        const step = steps.find((candidate) => candidate.id === id);
        const pinnedEnv = String(step?.env?.PINNED ?? "").trim();
        if (pinnedEnv !== "${{ steps.layers.outputs.ref }}") {
          mismatches.push({
            file: rel,
            expected: `the ${id} step's PINNED env carrying the layers step's published ref`,
            got: pinnedEnv === "" ? `no PINNED env on the ${id} step` : pinnedEnv,
          });
        }
      }
      return mismatches;
    },
  },
  {
    name: "settings-hide-details",
    run: () => {
      // The layers step and the label preflight run BEFORE the settings
      // action applies, so the action's own redaction cannot cover their
      // output, and both quote repo-owned content on their diagnostic
      // paths. The row's private flag must therefore reach them: it has to
      // ride the matrix AND be handed to both steps, which pass it to
      // run_hidden.ts. This was dropped once already, with a comment
      // explaining why it was safe - it was not, so the invariant is pinned
      // rather than commented.
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
      // Per LEG and per row: the labels leg gets its argv from
      // layerStepArgv, whose one return applies the wrapper, so the argv is
      // read for both rows and must open with the wrapper, a "settings
      // <leg>" label, and the leg's own script. The workflow runs the leg
      // through the layer step, never the fleet script directly (a direct
      // call is an unwrapped one). The layers step and the freshness
      // recheck are inline calls matched textually: the first quotes a
      // fetched file's parse error, the second's moved warning quotes
      // commit shas and its resolver errors name the target's default branch.
      const LEG_SCRIPTS: Record<LayerStep, string> = {
        labels: "label_preflight.ts",
      };
      for (const leg of LAYER_STEPS) {
        for (const operator of [true, false]) {
          const argv = layerStepArgv(leg, { ...LEG_FACTS, operator });
          const wrapped =
            argv[0] === "bun" &&
            argv[1].endsWith("/sync/run_hidden.ts") &&
            /^settings [a-z]+$/.test(argv[2]) &&
            argv[3] === "--" &&
            argv[4] === "bun" &&
            argv[5].endsWith(`/fleet/${LEG_SCRIPTS[leg]}`);
          if (!wrapped) {
            mismatches.push({
              file: ".github/scripts/fleet/settings_layer_step.ts",
              expected: `the ${leg} leg (${operator ? "operator" : "fetched"} row) wrapped in run_hidden.ts under a "settings <leg>" label, running fleet/${LEG_SCRIPTS[leg]}`,
              got: argv.join(" "),
            });
          }
        }
        const step = workflowSteps(".github/workflows/settings-repos.yml").find(
          (s) => s.id === leg,
        );
        const run = String(step?.run ?? "");
        if (run !== `bun .github/scripts/fleet/settings_layer_step.ts ${leg}`) {
          mismatches.push({
            file: ".github/workflows/settings-repos.yml",
            expected: `the ${leg} step running exactly 'bun .github/scripts/fleet/settings_layer_step.ts ${leg}'`,
            got: run === "" ? `no step with id ${leg}` : run,
          });
        }
      }
      const flat = workflow.replace(/\\[ \t]*\n/g, " ").replace(/\s+/g, " ");
      for (const script of Object.values(LEG_SCRIPTS)) {
        if (flat.includes(`fleet/${script}`)) {
          mismatches.push({
            file: ".github/workflows/settings-repos.yml",
            expected: `no direct ${script} call (the layer step wraps it)`,
            got: "a direct call",
          });
        }
      }
      for (const script of ["settings_layers.ts", "check_target_fresh.ts"]) {
        const call = new RegExp(
          `bun \\.github\\/scripts\\/fleet\\/${script.replace(".", "\\.")}`,
          "g",
        );
        const calls = flat.match(call) ?? [];
        const wrapped =
          flat.match(new RegExp(`run_hidden\\.ts "settings [a-z]+" -- ${call.source}`, "g")) ?? [];
        if (calls.length === 0 || wrapped.length !== calls.length) {
          mismatches.push({
            file: ".github/workflows/settings-repos.yml",
            expected: `every ${script} call wrapped in run_hidden.ts (${calls.length} call(s))`,
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
        [/steps\.layers\.outputs\.skipped == 'true'/, "a condition on the layers step's output"],
      ]);
      const skipStep = steps.get("Report a skipped target");
      if (skipStep !== undefined && !printsNotice(skipStep, read)) {
        mismatches.push({
          file: '.github/workflows/settings-repos.yml step "Report a skipped target"',
          expected: "a public notice (inline, or the top-level action of the script it runs)",
          got: "missing",
        });
      }
      // The whole point of that step is being OUTSIDE the capture, so the
      // wrapper is checked as a forbidden token, not a negated pattern.
      if (skipStep !== undefined && runsHidden(skipStep, read)) {
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
      // dropped the module or has no settings.yml of its own publishes no
      // layer list, and a target whose branch moved has a stale one. No
      // unit test can see a workflow, so the shape is asserted here - on
      // the parsed steps, not on the file's text, so a matching string in
      // a comment or an unrelated step cannot satisfy it.
      const mismatches: Mismatch[] = [];
      const expected: Record<string, string> = {
        freshness: "steps.layers.outputs.skipped == 'false'",
        action: "steps.freshness.outputs.moved == 'false'",
      };
      {
        const rel = ".github/workflows/settings-repos.yml";
        const steps = workflowSteps(rel);
        for (const [id, condition] of Object.entries(expected)) {
          // EVERY settings-action step (the merge and the apply), not the
          // first: a second, ungated invocation would otherwise pass.
          const matched =
            id === "action"
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
    // The two settings-action steps meet at ONE file: the merge step folds
    // the layers step's published list into it (no token, no target), and
    // the apply step reads it. A one-line regression - the apply reading a
    // single layer, the merge folding a list from anywhere else - ships a
    // document the layer pipeline exists to never produce, because the
    // action's label reconciliation would delete every label the repository
    // declares for itself, and every other gate stays green while it does.
    name: "settings-apply-merged-input",
    run: () => {
      const rel = ".github/workflows/settings-repos.yml";
      const steps = workflowSteps(rel).filter((step) =>
        String(step.uses ?? "").includes("github-settings-as-code"),
      );
      if (steps.length === 0)
        throw new Error(`${rel}: no github-settings-as-code step - anchor lost`);
      return settingsActionStepMismatches(rel, steps);
    },
  },
  {
    // Every run_hidden-wrapped step in settings-repos.yml must be followed by
    // a PUBLIC ::notice:: step firing on one of the wrapped step's own outputs:
    // the capture swallows a wrapped step's success output, warnings included,
    // so without a compensating notice its skip is a green job with no signal.
    // DERIVED from the workflow rather than pinned per step because this gap
    // was reintroduced three times one step at a time; a fourth wrapped script
    // fails here until it gets its notice. Order is part of the requirement:
    // a notice BEFORE the wrapped step reads outputs that do not exist yet.
    name: "settings-hidden-step-notices",
    run: () => {
      const rel = ".github/workflows/settings-repos.yml";
      const jobs = asRecord(asRecord(parseYaml(read(rel)), rel).jobs ?? {}, `${rel} jobs`);
      const { wrapped, mismatches } = hiddenStepNoticeMismatches(rel, jobs, read);
      if (wrapped === 0) throw new Error(`${rel}: no run_hidden-wrapped steps - anchor lost`);
      return mismatches;
    },
  },
];
