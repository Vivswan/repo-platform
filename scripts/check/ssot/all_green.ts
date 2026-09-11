// Rules holding the all-green verdict together: the authored gating-job
// rosters for ci.yml and fleet-ci.yml, the gate check's name, and the local
// check chain that mirrors CI.

import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CHECK_NAME } from "../../../.github/scripts/shared/all_green.ts";
import { loadOverrideLayer } from "../../../.github/scripts/sync/writer/merge_settings_layers.ts";
import { substitute } from "../../../.github/scripts/sync/writer/placeholders.ts";
import { constStringValue, templateCarries } from "../../lib/ts_extract.ts";
import { canonical, escapeRegExp, type Mismatch, mustMatch, setMismatch } from "./comparison.ts";
import { asRecord, ciJobs, packageScripts, REPO_ROOT, read, repoCi } from "./inputs.ts";
import { FLEET_WRITERS, POST_GREEN_REL } from "./post_green.ts";
import type { Rule } from "./rule_roster.ts";

/** The check-run lookup template's leading text, backtick included: the
 *  green gates must key their lookup on the shared CHECK_NAME constant.
 *  Matched against string/template literals only (templateCarries), so a
 *  commented-out copy of the wiring is not a literal and never counts. */
export const CHECK_RUN_LOOKUP =
  "`repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}";

/** The predicate's declared check name, read from the AST: the single
 *  top-level `export const CHECK_NAME` declaration whose value is a
 *  plain string literal. A look-alike inside a comment, a string, or a
 *  multiline template is not a declaration node and can never be the one
 *  found; a declaration rewritten to any non-literal shape (a
 *  concatenation, a join) throws anchor-lost rather than passing on a
 *  value the pin cannot see whole. */
export function declaredCheckName(source: string): string {
  return constStringValue(source, "CHECK_NAME", {
    where: "all_green.ts",
    what: "verdict check name",
    exported: true,
  });
}

export const ALL_GREEN_ACTION = "actions/all-green/action.yml";
const JUDGE_STEP = "Judge every needed result";

/** The judge step's run block, off the parsed action: the one bash the
 *  gate executes and the substitution ban audits. A renamed or reshaped
 *  step throws anchor-lost rather than auditing nothing. */
export function judgeRunBlock(actionText: string): string {
  const action = asRecord(parseYaml(actionText), ALL_GREEN_ACTION);
  const steps = asRecord(action.runs ?? {}, `${ALL_GREEN_ACTION} runs`).steps;
  const judge = (Array.isArray(steps) ? steps : [])
    .map((step) => asRecord(step, `${ALL_GREEN_ACTION} step`))
    .find((step) => step.name === JUDGE_STEP);
  if (judge === undefined || typeof judge.run !== "string") {
    throw new Error(`${ALL_GREEN_ACTION}: no '${JUDGE_STEP}' step with a run block - anchor lost`);
  }
  return judge.run;
}

/** The lines of a bash script whose command substitution sits anywhere
 *  but opening a plain assignment (`var="$(...)"`, or `if ! var="$(...)";
 *  then`, where the status IS the tested thing), as `line:text`. Inside
 *  [ ], [[ ]], test, or case words a substitution is errexit-exempt, so
 *  a crashing probe reads as empty and the guard falls OPEN; `$((...))`
 *  runs no command. Comment lines are skipped. */
export function bannedSubstitutions(script: string): string[] {
  const offenders: string[] = [];
  script.split("\n").forEach((line, index) => {
    if (/^[ \t]*#/.test(line)) return;
    const count = line.replaceAll("$((", "").split("$(").length - 1;
    if (count === 0) return;
    let bad = count > 1 || !/^[ \t]*(if ! )?[A-Za-z_][A-Za-z0-9_]*="\$\(/.test(line);
    const close = line.lastIndexOf(')"');
    if (
      close >= 0 &&
      !/^( \|\| (return|exit) [1-9][0-9]*)?(; then)?$/.test(line.slice(close + 2))
    ) {
      bad = true;
    }
    if (bad) offenders.push(`${index + 1}:${line}`);
  });
  return offenders;
}

/** The judge block's errexit discipline: `set -euo pipefail` first (the
 *  ban below assumes errexit), then no substitution outside a plain
 *  assignment. Pure, for the forcing tests. */
export function judgeSubstitutionMismatches(actionText: string): Mismatch[] {
  const file = `${ALL_GREEN_ACTION} step '${JUDGE_STEP}'`;
  const run = judgeRunBlock(actionText);
  const mismatches: Mismatch[] = [];
  const first = run
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#"));
  if (first !== "set -euo pipefail") {
    mismatches.push({
      file,
      expected:
        "`set -euo pipefail` as the first command (a crashed jq must fail the step, not read as empty)",
      got: first ?? "an empty run block",
    });
  }
  for (const offender of bannedSubstitutions(run)) {
    mismatches.push({
      file,
      expected:
        "command substitution only opening a plain assignment (errexit-exempt inside [ ], [[ ]], test, or case words, where a crashed jq reads as empty and the gate falls open)",
      got: offender,
    });
  }
  return mismatches;
}

/** Transitively expand a package.json script through its `bun run X` calls;
 *  returns the concatenated bodies and every script name reached. */
export function expandCheckChain(
  scripts: Record<string, string>,
  entry: string,
): { text: string; names: Set<string> } {
  const names = new Set<string>();
  const bodies: string[] = [];
  const visit = (name: string) => {
    if (names.has(name) || !(name in scripts)) return;
    names.add(name);
    const body = scripts[name];
    bodies.push(body);
    for (const match of body.matchAll(/bun run ([A-Za-z0-9:_-]+)/g)) visit(match[1]);
  };
  visit(entry);
  return { text: bodies.join("\n"), names };
}

/** Every gating job in this repository's ci.yml, by job id: the authored
 *  twin of the all-green job's needs list (the all-green-roster rule holds
 *  the sides together). The run-time gate judges whatever its needs name,
 *  so a job deleted from ci.yml AND the needs list would stop gating with
 *  nothing to notice; this roster is where that deletion becomes loud.
 *  Adding or removing a gating job means editing both, deliberately, in one
 *  change. Jobs downstream of the gate (post-green) are the one exemption;
 *  every other job gates. */
export const ALL_GREEN_ROSTER = [
  "actionlint",
  "gitleaks",
  "dependency-review",
  "allgreen-judgment",
  "yamllint",
  "biome",
  "typography",
  "file-size",
  "commit-names",
  "typecheck",
  "action-refs",
  "invariants",
  "build-tree",
  "script-tests",
  "validate-skills",
  "skills-discovery",
  "pages-site-build",
  "codeql-javascript",
  "zizmor",
  "typos",
  "knip",
  "semgrep",
  "bun-setup-smoke",
  "trivy",
];

/** Set comparison between an authored roster and a gating-job list.
 *  Both directions are load-bearing: a gating job missing from the
 *  roster is a gate the roster never vouched for, and a roster entry with
 *  no job is a REMOVED gate - the sneaky case, where deleting the job
 *  would otherwise change nothing the gate can see. Callers hand in the
 *  GATING job list (the gate's own and downstream jobs already
 *  excluded). */
export function rosterMismatches(
  roster: string[],
  gating: string[],
  site: { jobsFile: string; rosterName: string },
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const duplicate = roster.find((job, index) => roster.indexOf(job) !== index);
  if (duplicate !== undefined) {
    mismatches.push({
      file: `scripts/check/ssot/all_green.ts ${site.rosterName}`,
      expected: "each gating job listed once",
      got: `'${duplicate}' is listed more than once`,
    });
  }
  const expected = new Set(roster);
  for (const job of gating) {
    if (!expected.has(job)) {
      mismatches.push({
        file: site.jobsFile,
        expected: `job '${job}' in scripts/check/ssot/all_green.ts's ${site.rosterName} (every gating job there feeds the all-green gate)`,
        got: "not in the roster - add it there (and to the all-green needs list), deliberately",
      });
    }
  }
  const present = new Set(gating);
  for (const job of roster) {
    if (!present.has(job)) {
      mismatches.push({
        file: `scripts/check/ssot/all_green.ts ${site.rosterName}`,
        expected: `a ${site.jobsFile} job '${job}'`,
        got: "no such job - removing a gate is a roster edit too; delete the entry in the same change, deliberately",
      });
    }
  }
  return mismatches;
}

/** The meta-check gate's shape over this repository's parsed ci.yml against
 *  the authored roster. The all-green JOB's own check run is the ruleset's
 *  required check, so it must exist, carry exactly `if: always()` (a failed
 *  dependency must FAIL the gate, not skip it), need EXACTLY the roster (a
 *  dropped needs entry un-gates a job that keeps running), and judge through
 *  the shared action. Gating jobs stay unconditional and un-renamed (a
 *  skipped RESULT stands down; conditions go on steps); downstream jobs are
 *  exempt from the roster but must spell out the gate's result. Pure, for the forcing tests. */
export function allGreenGateMismatches(
  ci: Record<string, unknown>,
  roster: string[],
  site: { jobsFile: string; rosterName: string } = {
    jobsFile: ".github/workflows/ci.yml",
    rosterName: "ALL_GREEN_ROSTER",
  },
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const jobs = ciJobs(ci, site.jobsFile);
  const jobNeeds = (job: unknown): string[] => {
    const needs = asRecord(job ?? {}, "job").needs;
    if (typeof needs === "string") return [needs];
    return Array.isArray(needs) ? needs.map(String) : [];
  };
  const gate = jobs["all-green"];
  if (gate === undefined) {
    mismatches.push({
      file: site.jobsFile,
      expected:
        "an 'all-green' job (its own check run is the ruleset's required check - without it nothing can merge)",
      got: "no such job",
    });
    return mismatches;
  }
  const downstream = new Set(
    Object.entries(jobs)
      .filter(([name, job]) => name !== "all-green" && jobNeeds(job).includes("all-green"))
      .map(([name]) => name),
  );
  const gating = Object.keys(jobs).filter((name) => name !== "all-green" && !downstream.has(name));
  mismatches.push(...rosterMismatches(roster, gating, site));
  const gateRecord = asRecord(gate, "all-green");
  const needs = jobNeeds(gateRecord);
  const needsDuplicate = needs.find((job, index) => needs.indexOf(job) !== index);
  if (needsDuplicate !== undefined) {
    mismatches.push({
      file: `${site.jobsFile} job 'all-green'`,
      expected: "each needs entry once",
      got: `'${needsDuplicate}' is needed more than once`,
    });
  }
  if (canonical([...needs].sort()) !== canonical([...roster].sort())) {
    mismatches.push({
      file: `${site.jobsFile} job 'all-green'`,
      expected: `needs exactly the ${site.rosterName} jobs (a dropped entry un-gates a job that keeps running; an extra one references a job the census does not know)`,
      got: canonical([...needs].sort()),
    });
  }
  if (String(gateRecord.if ?? "").trim() !== "always()") {
    mismatches.push({
      file: `${site.jobsFile} job 'all-green'`,
      expected:
        "exactly `if: always()` (without it a failed dependency SKIPS the gate instead of failing it, and extra clauses weaken it)",
      got: gateRecord.if === undefined ? "no condition" : String(gateRecord.if),
    });
  }
  if (gateRecord.name !== undefined) {
    mismatches.push({
      file: `${site.jobsFile} job 'all-green'`,
      expected: "no name: override (the job id IS the required check-run name)",
      got: `name: ${String(gateRecord.name)}`,
    });
  }
  // A matrix would suffix the job's check-run names (all-green (x)),
  // and the ruleset requires the exact context.
  if (gateRecord.strategy !== undefined) {
    mismatches.push({
      file: `${site.jobsFile} job 'all-green'`,
      expected:
        "no strategy: on the gate (a matrix suffixes the check-run name away from the required context)",
      got: "a strategy key",
    });
  }
  // The judgment step: the shared action, with the needs context wired
  // in - without the input the action judges nothing. No step in the
  // gate job may carry a condition or failure softening: a skipped or
  // continue-on-error'd judgment is a green check over an unjudged run.
  const steps = (gateRecord.steps as Record<string, unknown>[] | undefined) ?? [];
  for (const step of steps) {
    if (step.if !== undefined || step["continue-on-error"] !== undefined) {
      mismatches.push({
        file: `${site.jobsFile} job 'all-green'`,
        expected:
          "no if: or continue-on-error: on any gate step (a skipped or softened judgment is a green check over an unjudged run)",
        got: canonical(step.uses ?? step.run ?? null),
      });
    }
  }
  const judge = steps.find((step) => String(step.uses ?? "") === "./actions/all-green");
  if (judge === undefined) {
    mismatches.push({
      file: `${site.jobsFile} job 'all-green'`,
      expected: "a step using ./actions/all-green (the shared judgment)",
      got: "no such step",
    });
  } else if (
    String(asRecord(judge.with ?? {}, "all-green with").needs ?? "") !== "${{ toJSON(needs) }}"
  ) {
    mismatches.push({
      file: `${site.jobsFile} job 'all-green'`,
      expected:
        "the judgment step passing needs: toJSON(needs) (anything else judges a fiction of the run)",
      got: canonical(judge.with ?? null),
    });
  }
  for (const name of gating) {
    const job = asRecord(jobs[name] ?? {}, name);
    // The meta-check treats a skipped result as standing down, so a
    // job-level `if:` on a gating job fails OPEN; event conditions go on
    // steps.
    if (job.if !== undefined) {
      mismatches.push({
        file: `${site.jobsFile} job '${name}'`,
        expected:
          "no job-level if: on a gating job (a skipped job stands down in the all-green gate - put event conditions on the steps)",
        got: "a job-level condition",
      });
    }
    if (job.name !== undefined) {
      mismatches.push({
        file: `${site.jobsFile} job '${name}'`,
        expected: "no job-level name: on a gating job (ids are the roster's identity)",
        got: `name: ${String(job.name)}`,
      });
    }
  }
  for (const name of downstream) {
    const condition = String(asRecord(jobs[name] ?? {}, name).if ?? "");
    // The gate clause must be present AND undefeatable, so the condition
    // is an &&-chain drawn from a closed alphabet: any clause outside it
    // (an || arm, always()/failure(), a chained or parenthesized
    // comparison such as `(true && <gate>) == false`) is refused whole.
    // `!cancelled()` is the one status function in the alphabet: it only
    // narrows, and a leg ordered behind a sibling it does not gate on
    // needs it to run past that sibling's red or skip.
    const clauses = condition.split("&&").map((clause) => clause.trim());
    if (
      !clauses.includes(DOWNSTREAM_GATE_CLAUSE) ||
      clauses.some((clause) => !DOWNSTREAM_CLAUSES.has(clause))
    ) {
      mismatches.push({
        file: `${site.jobsFile} job '${name}'`,
        expected:
          `an &&-chain of clauses from [${[...DOWNSTREAM_CLAUSES].join(", ")}] including ` +
          `${DOWNSTREAM_GATE_CLAUSE} (any other clause - an || arm, another status function, ` +
          "a chained or parenthesized comparison - could release post-gate work off a red gate)",
        got: condition === "" ? "no condition" : condition,
      });
    }
  }
  return mismatches;
}

/** The managed skeleton's gate, judged on the parsed document: `all-green`
 *  needs exactly the two callers and judges through the published action
 *  under `if: always()`; the `ci` caller is unconditional and `checks`
 *  skips only on the schedule (the schedule run is the fleet callers');
 *  `nightly` runs on the schedule alone and gates nothing; every other job
 *  needs `all-green` (directly or through a job that does) and every job
 *  needing it directly spells the gate clause in its condition. Pure, for
 *  the forcing tests: a skeleton with `needs: [checks]` would let a green
 *  checks job vouch for a red fleet run. */
export function skeletonGateMismatches(
  skeleton: Record<string, unknown>,
  jobsFile: string = SKELETON_SOURCE,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const jobs = ciJobs(skeleton, jobsFile);
  const at = (job: string) => `${jobsFile} job '${job}'`;
  const needsOf = (name: string): string[] => {
    const needs = asRecord(jobs[name] ?? {}, name).needs;
    if (typeof needs === "string") return [needs];
    return Array.isArray(needs) ? needs.map(String) : [];
  };
  const condition = (name: string): string =>
    String(asRecord(jobs[name] ?? {}, name).if ?? "")
      .split(/\s+/)
      .join(" ")
      .trim();
  for (const name of ["checks", "ci", "nightly", "all-green"]) {
    if (!(name in jobs)) {
      mismatches.push({ file: at(name), expected: "the job present", got: "no such job" });
    }
  }
  if (mismatches.length > 0) return mismatches;
  const gate = asRecord(jobs["all-green"], "all-green");
  if (canonical([...needsOf("all-green")].sort()) !== canonical(["checks", "ci"])) {
    mismatches.push({
      file: at("all-green"),
      expected:
        "needs: [checks, ci] (both callers; a dropped caller lets the other one's green vouch for a red run)",
      got: canonical(needsOf("all-green")),
    });
  }
  if (condition("all-green") !== "always()") {
    mismatches.push({
      file: at("all-green"),
      expected: "exactly `if: always()` (a failed caller must FAIL the gate, not skip it)",
      got: gate.if === undefined ? "no condition" : String(gate.if),
    });
  }
  const steps = (gate.steps as Record<string, unknown>[] | undefined) ?? [];
  const judge = steps.find((step) =>
    /\/repo-platform\/actions\/all-green@build$/.test(String(step.uses ?? "")),
  );
  if (
    steps.length !== 1 ||
    judge === undefined ||
    judge.if !== undefined ||
    judge["continue-on-error"] !== undefined ||
    String(asRecord(judge.with ?? {}, "all-green with").needs ?? "") !== "${{ toJSON(needs) }}"
  ) {
    mismatches.push({
      file: at("all-green"),
      expected:
        "one unconditioned, unsoftened step, uses: <owner>/repo-platform/actions/all-green@build with needs: toJSON(needs)",
      got: canonical(
        steps.map((step) => ({
          uses: step.uses ?? null,
          with: step.with ?? null,
          if: step.if ?? null,
          "continue-on-error": step["continue-on-error"] ?? null,
        })),
      ),
    });
  }
  const calls = (name: string, workflow: string) => {
    const uses = String(asRecord(jobs[name] ?? {}, name).uses ?? "");
    // The workflow file name is one of this rule's own literals below, escaped; the rest is literal.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const pinned = new RegExp(
      `/repo-platform/\\.github/workflows/${escapeRegExp(workflow)}@build$`,
    );
    if (!pinned.test(uses)) {
      mismatches.push({
        file: at(name),
        expected: `uses: <owner>/repo-platform/.github/workflows/${workflow}@build`,
        got: uses || "no uses:",
      });
    }
  };
  calls("ci", "fleet-ci.yml");
  calls("nightly", "fleet-nightly.yml");
  if (condition("ci") !== "") {
    mismatches.push({
      file: at("ci"),
      expected: "no job-level if: (a skipped caller stands down in the gate)",
      got: condition("ci"),
    });
  }
  if (condition("checks") !== "github.event_name != 'schedule'") {
    mismatches.push({
      file: at("checks"),
      expected:
        "exactly `if: github.event_name != 'schedule'` (the schedule run is the fleet callers' alone)",
      got: condition("checks") || "no condition",
    });
  }
  if (condition("nightly") !== "github.event_name == 'schedule'" || needsOf("nightly").length > 0) {
    mismatches.push({
      file: at("nightly"),
      expected: "exactly `if: github.event_name == 'schedule'` and no needs (it gates nothing)",
      got: `if: ${condition("nightly") || "none"}, needs: ${canonical(needsOf("nightly"))}`,
    });
  }
  const reachesGate = (name: string, seen = new Set<string>()): boolean =>
    needsOf(name).some(
      (dep) => dep === "all-green" || (!seen.has(dep) && reachesGate(dep, seen.add(dep))),
    );
  for (const name of Object.keys(jobs)) {
    if (["checks", "ci", "nightly", "all-green"].includes(name)) continue;
    if (!reachesGate(name)) {
      mismatches.push({
        file: at(name),
        expected: "needs reaching all-green (every leg after the callers rides behind the gate)",
        got: canonical(needsOf(name)),
      });
    }
    if (needsOf(name).includes("all-green")) {
      // The same closed alphabet as the operator's gate: an &&-chain
      // whose every clause is a known narrowing, so an || arm or a status
      // function cannot release the leg off a red gate.
      const clauses = condition(name)
        .split("&&")
        .map((clause) => clause.trim());
      if (
        !clauses.includes(DOWNSTREAM_GATE_CLAUSE) ||
        clauses.some((clause) => !SKELETON_CLAUSES.some((allowed) => allowed.test(clause)))
      ) {
        mismatches.push({
          file: at(name),
          expected: `an &&-chain of the skeleton's leg clauses including ${DOWNSTREAM_GATE_CLAUSE} (needing the gate orders the job; the clause gates it, and no other clause shape may weaken it)`,
          got: condition(name) || "no condition",
        });
      }
    }
  }
  return mismatches;
}

/** The clauses a skeleton leg's `if:` may be composed of, joined by `&&`
 *  only: the gate clause, the main-push scoping, `!cancelled()`, the hook's
 *  result, and the module tests on the plan's compact JSON output. */
const SKELETON_CLAUSES: readonly RegExp[] = [
  /^needs\.all-green\.result == 'success'$/,
  /^needs\.post-green\.result == 'success'$/,
  /^github\.event_name == 'push'$/,
  /^github\.ref == 'refs\/heads\/main'$/,
  /^!cancelled\(\)$/,
  /^!?contains\(needs\.ci\.outputs\.modules, '"[a-z-]+"'\)$/,
];

/** The clause every downstream job's condition must carry. */
export const DOWNSTREAM_GATE_CLAUSE = "needs.all-green.result == 'success'";

/** Every clause a downstream job's `if:` may be composed of, joined by
 *  `&&` only: the gate clause, the main-push scoping, and `!cancelled()`
 *  for a leg with order edges. A new clause joins here deliberately. */
export const DOWNSTREAM_CLAUSES: ReadonlySet<string> = new Set([
  DOWNSTREAM_GATE_CLAUSE,
  "!cancelled()",
  "github.event_name == 'push'",
  "github.ref == 'refs/heads/main'",
]);

/** Every gating job in fleet-ci.yml, by job id (ALL_GREEN_ROSTER's fleet
 *  counterpart): a job deleted there stops gating the whole fleet with no
 *  per-repo diff. The seven base checks are STEPS of base-checks (shape test);
 *  plan is the first job, whose outputs every other job keys on. */
export const FLEET_CI_ROSTER = [
  "plan",
  "validate-managed-files",
  "base-checks",
  "dependency-review",
  "zizmor",
  "knip",
  "semgrep",
  "codeql",
  "validate-skills",
  "release-freshness",
  "release-health",
  "trivy",
];

export const FLEET_CI_SOURCE = ".github/workflows/fleet-ci.yml";

/** fleet-ci.yml's jobs by id, off the file text: the one parse every fleet-ci rule shares. */
export function fleetCiJobs(text: string): Record<string, unknown> {
  return ciJobs(asRecord(parseYaml(text), FLEET_CI_SOURCE), FLEET_CI_SOURCE);
}

/** The plan job carries no job-level `if:`.
 *  On a schedule run the skeleton's `checks` job skips (files/base/.github/workflows/ci.yml) and every other fleet-ci job stands down, codeql excepted on its weekly day.
 *  plan's success is then the one result the all-green gate can count on, and the gate fails closed on an all-skipped run.
 *  A missing plan job is the roster rule's finding, not this one's. Pure, for the forcing tests. */
export function planUnconditionalMismatches(text: string): Mismatch[] {
  const plan = fleetCiJobs(text).plan;
  if (plan === undefined) return [];
  const job = asRecord(plan, "plan");
  if (job.if === undefined) return [];
  return [
    {
      file: `${FLEET_CI_SOURCE} job 'plan'`,
      expected:
        "no job-level if: (plan is the one fleet-ci job that runs on every schedule run, so its success is what keeps every managed repository's nightly all-green from failing closed on an all-skipped run)",
      got: `if: ${String(job.if)}`,
    },
  ];
}

/** Every job in fleet-nightly.yml, by job id: the schedule-only leg the
 *  skeleton's `nightly` caller runs beside fleet-ci's schedule run (where
 *  only plan and, on the weekly day, codeql run). Not a gate - nothing
 *  here feeds all-green - but a job deleted here stops the fleet's nightly
 *  scan with no per-repo diff. */
export const FLEET_NIGHTLY_ROSTER = ["plan", "trivy-nightly"];

/** The skeleton ci.yml the writer ships to every fleet repository, one
 *  file whatever the selection, so its caller jobs' grants are the
 *  ceilings the called workflows live under. */
export const SKELETON_SOURCE = "files/base/.github/workflows/ci.yml";

/** The skeleton parsed; its only placeholder is the owner, which no grant depends on. */
export function skeletonCi(): Record<string, unknown> {
  const text = substitute(read(SKELETON_SOURCE), { github_username: "owner" });
  return asRecord(parseYaml(text), SKELETON_SOURCE);
}

/** Each fleet-facing called workflow and the skeleton job that calls it:
 *  the caller job's permissions are the ceiling every job of the called
 *  workflow must fit. */
export const FLEET_CALLERS: Record<string, string> = {
  ".github/workflows/fleet-ci.yml": "ci",
  ".github/workflows/fleet-nightly.yml": "nightly",
};

/** The operator's own call chain, each called workflow with the job that calls it: ci.yml's
 *  post-green job calls post-green.yml, whose legs call the fleet writers (the writer roster's
 *  callerJob, so a newly registered writer is checked without a second listing). The same
 *  expansion-time check applies, so one scope over a ceiling here fails every main run. */
export const OPERATOR_CALLERS: Record<string, { rel: string; job: string }> = {
  [POST_GREEN_REL]: { rel: ".github/workflows/ci.yml", job: "post-green" },
  ...Object.fromEntries(
    Object.entries(FLEET_WRITERS).map(([rel, writer]) => [
      rel,
      { rel: POST_GREEN_REL, job: writer.callerJob },
    ]),
  ),
};

const PERMISSION_RANK: Record<string, number> = { none: 0, read: 1, write: 2 };

/** A called workflow's job grants against its caller job's grant, judged on
 *  the parsed documents (exported for the forcing tests). GitHub checks
 *  every nested job's permissions against the caller's when the call is
 *  EXPANDED, before any nested `if` runs, so one scope over the ceiling
 *  fails every caller's run at once - a skipped job included. A job
 *  without its own block inherits the called workflow's top-level block
 *  (none: the caller's, which fits by definition); a scope the caller
 *  omits is `none` there. Shorthand grants (read-all, write-all) on either
 *  side are refused: the ceiling must be spelled out per scope. */
export function callerCeilingMismatches(
  called: { rel: string; text: string },
  caller: { rel: string; job: string; permissions: unknown },
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const site = `${caller.rel} job '${caller.job}'`;
  if (typeof caller.permissions !== "object" || caller.permissions === null) {
    return [
      {
        file: site,
        expected: `a permissions mapping spelled out per scope (the ceiling for every ${called.rel} job)`,
        got: caller.permissions === undefined ? "no permissions block" : String(caller.permissions),
      },
    ];
  }
  const ceiling = caller.permissions as Record<string, unknown>;
  const doc = asRecord(parseYaml(called.text), called.rel);
  const jobs = ciJobs(doc, called.rel);
  for (const [name, raw] of Object.entries(jobs)) {
    const job = asRecord(raw ?? {}, name);
    const grant = job.permissions ?? doc.permissions;
    if (grant === undefined) continue;
    if (typeof grant !== "object" || grant === null) {
      mismatches.push({
        file: `${called.rel} job '${name}'`,
        expected:
          "a permissions mapping spelled out per scope (a shorthand grant cannot be judged against the caller's ceiling)",
        got: String(grant),
      });
      continue;
    }
    for (const [scope, level] of Object.entries(grant as Record<string, unknown>)) {
      const allowed = String(ceiling[scope] ?? "none");
      const wanted = String(level);
      if ((PERMISSION_RANK[wanted] ?? Infinity) > (PERMISSION_RANK[allowed] ?? -1)) {
        mismatches.push({
          file: `${called.rel} job '${name}'`,
          expected: `${scope}: at most ${allowed} (${site} grants that; GitHub rejects the whole call when a nested job asks for more, before its if: runs)`,
          got: `${scope}: ${wanted}`,
        });
      }
    }
  }
  return mismatches;
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const allGreenRules: Rule[] = [
  {
    name: "local-gates",
    run: () => {
      const mismatches: Mismatch[] = [];
      const scripts = packageScripts();
      const chain = expandCheckChain(scripts, "check");
      const jobs = ciJobs(repoCi(), "ci.yml");
      // The verdict roster IS the gating-job list now (the all-green-roster
      // rule pins it against ci.yml's actual jobs).
      const needs = ALL_GREEN_ROSTER;
      for (const jobName of needs) {
        const job = asRecord(jobs[jobName], jobName);
        const steps = (job.steps as Record<string, unknown>[] | undefined) ?? [];
        for (const step of steps) {
          for (const line of String(step.run ?? "").split("\n")) {
            const command = line.trim();
            if (!command.startsWith("bun ") || command.startsWith("bun install")) continue;
            // The ci/ scripts are CI-only by design (they need workflow
            // context: matrix rows, PR refs) and never belong in the local chain.
            if (command.startsWith("bun .github/scripts/ci/")) continue;
            const words = command.split(/\s+/);
            let reachable: boolean;
            let wanted: string;
            if (words[1] === "run") {
              wanted = `bun run ${words[2]}`;
              reachable = chain.names.has(words[2]);
            } else if (words[1] === "x") {
              wanted = `bun x ${words[2]}`;
              reachable = chain.text.includes(wanted);
            } else if (words[1] === "test") {
              wanted = "bun test";
              reachable = chain.text.includes(wanted);
            } else {
              wanted = `bun ${words[1]}`;
              reachable = chain.text.includes(wanted);
            }
            if (!reachable) {
              mismatches.push({
                file: `ci.yml job '${jobName}'`,
                expected: `'${command}' reachable from package.json's check chain`,
                got: `${wanted} missing from the chain`,
              });
            }
          }
        }
      }
      // The reverse direction, for the gates whose only CI home is a step in
      // a needed job: trimming the step out of ci.yml would silently stop
      // them running anywhere in CI while the chain (and this rule's forward
      // pass) stayed green. Line-anchored equality, so an echoed or
      // commented copy of the command cannot satisfy it.
      const gatingLines = new Set(
        needs.flatMap((jobName) => {
          const job = asRecord(jobs[jobName], jobName);
          return (
            ((job.steps as Record<string, unknown>[] | undefined) ?? [])
              // A `continue-on-error` step fails OPEN: its command runs but a
              // non-zero exit is swallowed, so the gate it was meant to be is
              // no gate. Drop those lines from the gating set - a required
              // command sitting on a suppressed step is the same missing gate
              // as a deleted step. (A plain `if:` is NOT rejected here: ci.yml
              // steps legitimately carry event conditions like
              // `if: github.event_name == 'pull_request'`, the repo
              // convention for keeping the JOB unconditional.)
              .filter((step) => step["continue-on-error"] === undefined)
              .flatMap((step) => [
                // `uses` counts too: a gate that moved into a composite action
                // has no run line left to pin, and deleting its step would fail
                // the gate open exactly as deleting a run line would.
                String(step.uses ?? "").trim(),
                ...String(step.run ?? "")
                  .split("\n")
                  .map((line) => line.trim()),
              ])
          );
        }),
      );
      for (const required of [
        "bun run ssot:check",
        // The test suite runs in CI only through this step, and only
        // through the package.json script does it get the launcher's
        // per-run TMPDIR (scripts/run_tests.ts): a bare `bun test` step
        // would pass the forward pass and leak fixtures on the runner.
        "bun run test",
        "bun run pins:check",
        "bun run theme:check",
        "bun run gitignore:topology",
        "bun run files:check",
        "bun run validate",
      ]) {
        if (!gatingLines.has(required)) {
          mismatches.push({
            file: "ci.yml",
            expected: `'${required}' as a run line of an all-green-needed job`,
            got: "missing",
          });
        }
      }
      return mismatches;
    },
  },
  {
    // The gate's shape at authoring time: the all-green job's needs list,
    // ci.yml's gating jobs, and the authored ALL_GREEN_ROSTER held
    // together in every direction (allGreenGateMismatches has the model).
    // This is where a deleted or un-needed gate goes loud.
    name: "all-green-roster",
    run: () => allGreenGateMismatches(repoCi(), ALL_GREEN_ROSTER),
  },
  {
    // The managed skeleton every fleet repository runs: its gate must need
    // both callers, judge through the published action under always(),
    // and every leg after it must ride behind the gate clause.
    name: "skeleton-gate",
    run: () => skeletonGateMismatches(skeletonCi()),
  },
  {
    // Every judge probe is a jq call under errexit; a substitution outside
    // a plain assignment is where a crashed jq would read as empty.
    name: "all-green-judge-substitutions",
    run: () => judgeSubstitutionMismatches(read(ALL_GREEN_ACTION)),
  },
  {
    // fleet-ci.yml's jobs against FLEET_CI_ROSTER, both directions. Job-level
    // `if:` is the design here (a skipped job leaves the caller green); info-*
    // ids, an all-green job, name:, and job-level continue-on-error are banned.
    name: "fleet-ci-roster",
    run: () => {
      const rel = FLEET_CI_SOURCE;
      const jobs = fleetCiJobs(read(rel));
      const mismatches = rosterMismatches(FLEET_CI_ROSTER, Object.keys(jobs), {
        jobsFile: rel,
        rosterName: "FLEET_CI_ROSTER",
      });
      for (const [name, raw] of Object.entries(jobs)) {
        const job = asRecord(raw ?? {}, name);
        if (name.startsWith("info-")) {
          mismatches.push({
            file: `${rel} job '${name}'`,
            expected:
              "no info-* job in the fleet's shared gate home (a fleet job either gates through the ci caller's result or does not exist; repo-local advisory jobs belong to checks.yml with continue-on-error)",
            got: "an info-* job id",
          });
        }
        if (name === "all-green") {
          mismatches.push({
            file: `${rel} job '${name}'`,
            expected:
              "no job named all-green here (the gate job lives in the rendered ci.yml; a nested look-alike would shadow the required-check story)",
            got: "an all-green job id",
          });
        }
        if (job.name !== undefined) {
          mismatches.push({
            file: `${rel} job '${name}'`,
            expected:
              "no job-level name: on a fleet gating job (ids are the roster's identity; a rename could hide a job from review)",
            got: `name: ${String(job.name)}`,
          });
        }
        if (job["continue-on-error"] !== undefined) {
          mismatches.push({
            file: `${rel} job '${name}'`,
            expected:
              "no job-level continue-on-error on a fleet gating job (a softened job reads green to every caller's all-green; an advisory check softens its own STEP inside base-checks)",
            got: `continue-on-error: ${String(job["continue-on-error"])}`,
          });
        }
      }
      return mismatches;
    },
  },
  {
    // plan is the one fleet-ci job that runs on every schedule run; gating
    // it off would turn every managed repository's nightly all-green red.
    name: "fleet-ci-plan-unconditional",
    run: () => planUnconditionalMismatches(read(FLEET_CI_SOURCE)),
  },
  {
    // fleet-nightly.yml's jobs against FLEET_NIGHTLY_ROSTER, both directions:
    // the split-off nightly leg has no caller result anyone judges, so a
    // deleted job there would go quiet fleet-wide.
    name: "fleet-nightly-roster",
    run: () => {
      const rel = ".github/workflows/fleet-nightly.yml";
      const jobs = ciJobs(asRecord(parseYaml(read(rel)), rel), rel);
      return rosterMismatches(FLEET_NIGHTLY_ROSTER, Object.keys(jobs), {
        jobsFile: rel,
        rosterName: "FLEET_NIGHTLY_ROSTER",
      });
    },
  },
  {
    // Every called workflow's job grants under its caller's: one scope over
    // the ceiling fails every fleet run (or every main run, for the operator's
    // own chain) at expansion, so the check runs here, before the edit ships.
    name: "fleet-caller-ceilings",
    run: () => {
      const callers = ciJobs(skeletonCi(), SKELETON_SOURCE);
      const fleet = Object.entries(FLEET_CALLERS).flatMap(([rel, job]) =>
        callerCeilingMismatches(
          { rel, text: read(rel) },
          {
            rel: SKELETON_SOURCE,
            job,
            permissions: asRecord(callers[job], `${SKELETON_SOURCE} job '${job}'`).permissions,
          },
        ),
      );
      const operator = Object.entries(OPERATOR_CALLERS).flatMap(([rel, caller]) => {
        const jobs = ciJobs(asRecord(parseYaml(read(caller.rel)), caller.rel), caller.rel);
        return callerCeilingMismatches(
          { rel, text: read(rel) },
          {
            ...caller,
            permissions: asRecord(jobs[caller.job], `${caller.rel} job '${caller.job}'`)
              .permissions,
          },
        );
      });
      return [...fleet, ...operator];
    },
  },
  {
    // The gate check's NAME, pinned once as data: the string the ruleset
    // REQUIRES and the job id whose check run CARRIES it must be provably the
    // same at authoring time, or a renamed job leaves branch protection
    // waiting forever while every job stays green. Its independently-authored
    // homes: the shared predicate's CHECK_NAME (which must also feed its own
    // check-run lookup), the all-green JOB id in this ci.yml and in the
    // managed one (a job's check run is named by its id; the roster rules
    // pin that neither carries name:), the override layer, and docs/all-green.md.
    name: "all-green-name",
    run: () => {
      const mismatches: Mismatch[] = [];
      const predicate = read(".github/scripts/shared/all_green.ts");
      // The IMPORTED constant is the authoritative name; the AST pin
      // (declaredCheckName) then proves the exported declaration NODE
      // carries the same value, so neither a decoy in a comment or
      // template nor a declaration rewritten off the string-literal
      // form can pass silently.
      const gateName = CHECK_NAME;
      const declared = declaredCheckName(predicate);
      if (declared !== gateName) {
        mismatches.push({
          file: ".github/scripts/shared/all_green.ts",
          expected: `the CHECK_NAME declaration line naming '${gateName}' (the imported constant)`,
          got: declared,
        });
      }
      // The publish/sync gates' LOOKUP must consume the same constant, or
      // they could read a differently named check than the one pinned.
      if (!templateCarries(predicate, CHECK_RUN_LOOKUP)) {
        throw new Error(
          "all_green.ts: anchor for a check-run lookup keyed on CHECK_NAME not found " +
            `(no template literal carries ${CHECK_RUN_LOOKUP})`,
        );
      }

      // The job whose check run carries the name, at both sources, on the
      // parsed documents.
      for (const [ci, where] of [
        [repoCi(), ".github/workflows/ci.yml"],
        [skeletonCi(), SKELETON_SOURCE],
      ] as const) {
        if (!(gateName in ciJobs(ci, where))) {
          mismatches.push({
            file: where,
            expected: `a job id '${gateName}' (the job's own check run is the required context)`,
            got: "no such job",
          });
        }
      }

      // The operator-facing contract's CANONICAL sentence must quote the
      // same name: anchored with mustMatch (the doc mentions all-green in
      // many places, so a bare .includes could stay green after the
      // contractual sentence changed or vanished).
      const documented = mustMatch(
        read("docs/all-green.md"),
        /required status check named `([^`]+)`/,
        "docs/all-green.md",
        "the required-check sentence",
      )[1];
      if (documented !== gateName) {
        mismatches.push({
          file: "docs/all-green.md",
          expected: `the required check documented as \`${gateName}\``,
          got: `\`${documented}\``,
        });
      }

      const contexts = (rulesets: Record<string, unknown>[], where: string): string[] => {
        const main = rulesets.find((r) => r.name === "main");
        if (!main) throw new Error(`${where}: no main ruleset - anchor lost`);
        const checksRule = (main.rules as Record<string, unknown>[]).find(
          (rule) => rule.type === "required_status_checks",
        );
        if (!checksRule) throw new Error(`${where}: no required_status_checks rule - anchor lost`);
        const params = asRecord(checksRule.parameters, `${where} parameters`);
        return (params.required_status_checks as Record<string, unknown>[]).map((c) =>
          String(c.context),
        );
      };
      // The override layer's main ruleset is the fleet's only home for
      // the gate context: exactly the all-green entry, nothing else (the
      // pr-title module's context rides its own baseline ruleset), and
      // loadOverrideLayer separately refuses an override that drops the
      // context or its Actions integration pin.
      const override = loadOverrideLayer(join(REPO_ROOT, "files/settings/override.yml"));
      mismatches.push(
        ...setMismatch(
          "files/settings/override.yml main ruleset required checks",
          [gateName],
          contexts(
            (override.rulesets ?? []) as Record<string, unknown>[],
            "files/settings/override.yml",
          ),
        ),
      );
      return mismatches;
    },
  },
];
