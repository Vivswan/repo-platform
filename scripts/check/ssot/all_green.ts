import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CHECK_NAME } from "../../../.github/scripts/shared/all_green.ts";
import { loadOverrideLayer } from "../../../.github/scripts/sync/writer/merge_settings_layers.ts";
import { substitute } from "../../../.github/scripts/sync/writer/placeholders.ts";
import { PLATFORM_NAME } from "../../../actions/shared/platform.ts";
import { constStringValue, templateCarries } from "../../lib/ts_extract.ts";
import { canonical, escapeRegExp, type Mismatch, mustMatch, setMismatch } from "./comparison.ts";
import { DELIVERY_REF } from "./delivery_pins.ts";
import { asRecord, ciJobs, packageScripts, REPO_ROOT, read, repoCi } from "./inputs.ts";
import { FLEET_WRITERS, POST_GREEN_REL } from "./post_green.ts";
import type { Rule } from "./rule_roster.ts";

/** The check-run lookup template's leading text, backtick included: the
 *  green gates must key their lookup on the shared CHECK_NAME constant.
 *  Matched against string/template literals only (templateCarries), so a
 *  commented-out copy of the wiring is not a literal and never counts. */
export const CHECK_RUN_LOOKUP =
  "`repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}";

export function declaredCheckName(source: string): string {
  return constStringValue(source, "CHECK_NAME", {
    where: "all_green.ts",
    what: "verdict check name",
    exported: true,
  });
}

/** The parsed `uses:` is checked here as well as by the line-reading action-pins rule: a folded `uses: >-` scalar hides its ref from
 *  that rule, and the required check may never ride a tag. The `with:` map is matched whole because alls-green accepts any result for
 *  a job in allowed-failures and a skip for one in allowed-skips, so an entry beyond the jobs that skip by design softens the gate. */
export const ALL_GREEN_JUDGE = "re-actors/alls-green";
const JUDGE_USES = new RegExp(`^${escapeRegExp(ALL_GREEN_JUDGE)}@[0-9a-f]{40}$`);
const NEEDS_AS_JSON = "${{ toJSON(needs) }}";

export function judgeStepMismatches(
  gate: Record<string, unknown>,
  site: string,
  allowedSkips: string | null,
): Mismatch[] {
  const steps = (gate.steps as Record<string, unknown>[] | undefined) ?? [];
  const expectedWith = {
    jobs: NEEDS_AS_JSON,
    ...(allowedSkips === null ? {} : { "allowed-skips": allowedSkips }),
  };
  const judge = steps.length === 1 ? steps[0] : undefined;
  if (
    judge !== undefined &&
    JUDGE_USES.test(String(judge.uses ?? "")) &&
    judge.if === undefined &&
    judge["continue-on-error"] === undefined &&
    canonical(judge.with ?? null) === canonical(expectedWith)
  ) {
    return [];
  }
  return [
    {
      file: site,
      expected:
        `exactly one unconditioned, unsoftened step, uses: ${ALL_GREEN_JUDGE}@<40-hex sha> with ${canonical(expectedWith)} ` +
        "(a conditioned, softened, or extra step is a green check over an unjudged run; an allowed-failures entry or an " +
        "allowed-skips entry beyond the jobs that skip by design lets a red or absent verdict pass)",
      got: canonical(
        steps.map((step) => ({
          uses: step.uses ?? null,
          with: step.with ?? null,
          if: step.if ?? null,
          "continue-on-error": step["continue-on-error"] ?? null,
        })),
      ),
    },
  ];
}

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

/** The run-time gate judges whatever its needs name, so a job deleted from ci.yml AND the needs list would stop gating with nothing to notice;
 *  this roster is where that deletion becomes loud (the all-green-roster rule). Adding or removing a gating job means editing both in one change;
 *  jobs downstream of the gate are the one exemption. */
export const ALL_GREEN_ROSTER = [
  "actionlint",
  "gitleaks",
  "dependency-review",
  "yamllint",
  "biome",
  "typography",
  "file-size",
  "commit-names",
  "typecheck",
  "invariants",
  "build-tree",
  "script-tests",
  "validate-skills",
  "skills-discovery",
  "docs-check",
  "pages-site-build",
  "codeql-javascript",
  "zizmor",
  "typos",
  "knip",
  "semgrep",
  "bun-setup-smoke",
  "trivy",
];

/** Callers hand in the GATING job list, the gate's own and downstream jobs already excluded. */
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
  if (gateRecord.strategy !== undefined) {
    mismatches.push({
      file: `${site.jobsFile} job 'all-green'`,
      expected:
        "no strategy: on the gate (a matrix suffixes the check-run name away from the required context)",
      got: "a strategy key",
    });
  }
  // No gating job here may skip (the job-level if: ban below), so no allowed-skips entry is ever right.
  mismatches.push(...judgeStepMismatches(gateRecord, `${site.jobsFile} job 'all-green'`, null));
  for (const name of gating) {
    const job = asRecord(jobs[name] ?? {}, name);
    if (job.if !== undefined) {
      mismatches.push({
        file: `${site.jobsFile} job '${name}'`,
        expected:
          "no job-level if: on a gating job (a skipped job fails the all-green gate - put event conditions on the steps)",
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
    // `(true && <gate>) == false` is why the chain is matched clause by clause against a closed alphabet.
    // `!cancelled()` is the one status function in it: it only narrows, and a leg ordered behind a sibling
    // it does not gate on needs it to run past that sibling's red or skip.
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
  mismatches.push(...judgeStepMismatches(gate, at("all-green"), SKELETON_ALLOWED_SKIPS));
  const calls = (name: string, workflow: string) => {
    const uses = String(asRecord(jobs[name] ?? {}, name).uses ?? "");
    if (!uses.endsWith(`/${PLATFORM_NAME}/.github/workflows/${workflow}@${DELIVERY_REF}`)) {
      mismatches.push({
        file: at(name),
        expected: `uses: <owner>/${PLATFORM_NAME}/.github/workflows/${workflow}@${DELIVERY_REF}`,
        got: uses || "no uses:",
      });
    }
  };
  calls("ci", "fleet-ci.yml");
  calls("nightly", "fleet-nightly.yml");
  if (condition("ci") !== "") {
    mismatches.push({
      file: at("ci"),
      expected:
        "no job-level if: (the gate never lets the ci caller skip, so a conditioned caller fails every run the condition misses)",
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

/** `checks` is the one caller that skips by design (the schedule run, and a checks.yml whose every job skips); `ci` never may,
 *  which is what keeps a schedule night's otherwise all-skipped run from passing. */
const SKELETON_ALLOWED_SKIPS = "checks";

const SKELETON_CLAUSES: readonly RegExp[] = [
  /^needs\.all-green\.result == 'success'$/,
  /^needs\.post-green\.result == 'success'$/,
  /^github\.event_name == 'push'$/,
  /^github\.ref == 'refs\/heads\/main'$/,
  /^!cancelled\(\)$/,
  /^!?contains\(needs\.ci\.outputs\.modules, '"[a-z-]+"'\)$/,
];

export const DOWNSTREAM_GATE_CLAUSE = "needs.all-green.result == 'success'";

export const DOWNSTREAM_CLAUSES: ReadonlySet<string> = new Set([
  DOWNSTREAM_GATE_CLAUSE,
  "!cancelled()",
  "github.event_name == 'push'",
  "github.ref == 'refs/heads/main'",
]);

/** A job deleted from fleet-ci.yml stops gating the whole fleet with no per-repo diff. The base checks are STEPS of base-checks, not jobs. */
export const FLEET_CI_ROSTER = [
  "plan",
  "validate-managed-files",
  "base-checks",
  "dependency-review",
  "zizmor",
  "knip",
  "semgrep",
  "codeql",
  "docs-check",
  "release-freshness",
  "release-health",
  "trivy",
];

export const FLEET_CI_SOURCE = ".github/workflows/fleet-ci.yml";

export function fleetCiJobs(text: string): Record<string, unknown> {
  return ciJobs(asRecord(parseYaml(text), FLEET_CI_SOURCE), FLEET_CI_SOURCE);
}

/** On a schedule run the skeleton's `checks` job skips and every other fleet-ci job stands down (codeql excepted on its weekly day),
 *  so plan is what keeps the `ci` caller from skipping, and the gate never lets `ci` skip. A missing plan job is the roster rule's finding. */
export function planUnconditionalMismatches(text: string): Mismatch[] {
  const plan = fleetCiJobs(text).plan;
  if (plan === undefined) return [];
  const job = asRecord(plan, "plan");
  if (job.if === undefined) return [];
  return [
    {
      file: `${FLEET_CI_SOURCE} job 'plan'`,
      expected:
        "no job-level if: (plan is the one fleet-ci job that runs on every schedule run, so it is what keeps the ci caller from skipping, which the all-green gate never allows)",
      got: `if: ${String(job.if)}`,
    },
  ];
}

/** Not a gate (nothing here feeds all-green), but a job deleted from fleet-nightly.yml stops the fleet's nightly scan with no per-repo diff. */
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
  ".github/workflows/reusable-site.yml": "site",
};

/** Derived from FLEET_WRITERS so a newly registered writer is checked without a second listing;
 *  one scope over a ceiling here fails every main run. */
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

/** GitHub checks nested job grants when the call is EXPANDED, before any nested `if` runs, so a skipped job over the ceiling fails the run too.
 *    job without its own block   -> inherits the called workflow's top-level block; none there means the caller's, which fits by definition
 *    scope the caller omits      -> none
 *    read-all / write-all        -> refused on either side: the ceiling must be spelled out per scope */
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

export const allGreenRules: Rule[] = [
  {
    name: "local-gates",
    run: () => {
      const mismatches: Mismatch[] = [];
      const scripts = packageScripts();
      const chain = expandCheckChain(scripts, "check");
      const jobs = ciJobs(repoCi(), "ci.yml");
      // ALL_GREEN_ROSTER stands in for the needs list: the all-green-roster rule pins them equal.
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
              // A continue-on-error step fails OPEN (its non-zero exit is swallowed), so its lines are no gate.
              // A plain `if:` stays: ci.yml steps carry event conditions, the convention for keeping the JOB unconditional.
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
        "bun run settings:check",
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
    name: "all-green-roster",
    run: () => allGreenGateMismatches(repoCi(), ALL_GREEN_ROSTER),
  },
  {
    name: "skeleton-gate",
    run: () => skeletonGateMismatches(skeletonCi()),
  },
  {
    // Job-level `if:` is allowed here, unlike the operator's gating jobs: a skipped fleet-ci job leaves the caller green.
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
    name: "fleet-ci-plan-unconditional",
    run: () => planUnconditionalMismatches(read(FLEET_CI_SOURCE)),
  },
  {
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
    // A renamed gate job leaves branch protection waiting forever while every job stays green, so the name is pinned across its homes here.
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
