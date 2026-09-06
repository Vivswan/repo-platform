import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";
import { isRecord, isRegularFile, regexLiteral, shapeOfYaml } from "../readers.ts";

const CI_PATH = ".github/workflows/ci.yml";

type Step = Record<string, unknown>;

/** The regex source matching the owner whose fleet-ci reusable this tree
 *  must call: the pinned answer on a render, any well-formed owner in self
 *  mode, and null while a render's answers cannot pin one (the fleet-caller
 *  check then stands down; the registration check reports the cause). */
function ownerPattern(ctx: Context): string | null {
  if (ctx.mode === "self") return "[A-Za-z0-9-]+";
  return ctx.owner === null ? null : regexLiteral(ctx.owner);
}

function jobNeeds(job: unknown): string[] {
  const needs = isRecord(job) ? job.needs : null;
  if (typeof needs === "string") return [needs];
  return Array.isArray(needs) ? needs.map(String) : [];
}

function jobSteps(job: unknown): Step[] {
  const steps = isRecord(job) ? job.steps : null;
  if (!Array.isArray(steps)) return [];
  return steps.filter(isRecord);
}

/** The judgment itself: the shared all-green action (local path on the
 *  operator, <owner>/repo-platform/actions/all-green@... on renders) WITH
 *  the needs context wired in - a canned needs input would judge a fiction
 *  of the run - unconditioned and unsoftened (a step that can skip or
 *  swallow its own failure while the job reports success is no judgment;
 *  the YAML parser normalizes quoted keys, so this covers '"if":' too). */
function judgesThroughAction(step: Step): boolean {
  if (
    !/^(?:\.\/actions\/all-green|[A-Za-z0-9-]+\/repo-platform\/actions\/all-green@.+)$/.test(
      String(step.uses ?? ""),
    )
  ) {
    return false;
  }
  if (step.if !== undefined || step["continue-on-error"] !== undefined) return false;
  const withBlock = isRecord(step.with) ? step.with : {};
  return String(withBlock.needs ?? "") === "${{ toJSON(needs) }}";
}

/** The all-green gate in ci.yml. The file is template-managed and always
 *  generated (repo-specific jobs live in the repo-owned checks.yml it
 *  calls), so a missing ci.yml means the repo is damaged. The gate is the
 *  all-green JOB: its own check run (named by the job id) is the ruleset's
 *  required context, so a repo that lost the job never gets the required
 *  check created again - fail-closed, but worth named errors. */
export function checkCiGate(ctx: Context): Finding[] {
  const path = join(ctx.root, CI_PATH);
  if (!isRegularFile(path)) {
    return [
      error(
        `${CI_PATH} is missing - the template always ` +
          "generates and manages it; restore the file from git history or " +
          "run a template sync",
      ),
    ];
  }
  let ci: unknown = {};
  try {
    ci = shapeOfYaml(readFileSync(path, "utf-8")) ?? {};
  } catch {
    ci = {};
  }
  const jobs =
    isRecord(ci) && typeof ci.jobs === "object" && ci.jobs !== null
      ? (ci.jobs as Record<string, unknown>)
      : null;
  if (jobs === null || Object.keys(jobs).length === 0) {
    return [
      error(
        "ci.yml: exists but defines no jobs - the file is empty or failed " +
          "to parse as YAML; restore the managed file via a template sync",
      ),
    ];
  }
  const findings: Finding[] = [];
  if (!("all-green" in jobs)) {
    findings.push(
      error(
        "ci.yml: no `all-green` job - its own check run is the required " +
          "all-green check, so nothing can merge without it; restore the " +
          "managed ci.yml from git history or run a template sync",
      ),
    );
  } else {
    const allGreen: Step = isRecord(jobs["all-green"]) ? jobs["all-green"] : {};
    const needs = jobNeeds(allGreen);
    // Jobs downstream of the gate (post-green and release-style legs) are
    // exempt from the needs census.
    const downstream = new Set(
      Object.entries(jobs)
        .filter(([name, job]) => name !== "all-green" && jobNeeds(job).includes("all-green"))
        .map(([name]) => name),
    );
    const missing = Object.keys(jobs)
      .filter((name) => name !== "all-green" && !downstream.has(name) && !needs.includes(name))
      .sort();
    if (missing.length > 0) {
      findings.push(
        error(
          `ci.yml: all-green \`needs:\` is missing job(s): ` +
            `${missing.join(", ")} - those jobs cannot gate ` +
            "merges; add them to the all-green job's needs list",
        ),
      );
    }
    const ifValue = typeof allGreen.if === "string" ? allGreen.if.trim() : "";
    if (ifValue !== "always()") {
      findings.push(
        error(
          "ci.yml: the all-green job must carry exactly `if: always()` - " +
            "without it a failed dependency skips the gate instead of " +
            "failing it, and extra conditions weaken the gate",
        ),
      );
    }
    if (!jobSteps(allGreen).some(judgesThroughAction)) {
      findings.push(
        error(
          "ci.yml: the all-green job has no judgment step - the gate is repo-platform's " +
            "all-green action with `needs: ${{ toJSON(needs) }}` wired in, unconditioned and " +
            "unsoftened; an inline `run:` script or a disabled action step judges nothing this " +
            "validator reads; run a template sync to restore the managed ci.yml",
        ),
      );
    }
  }
  // Client renders must carry the fleet gate home: an UNCONDITIONAL job
  // calling repo-platform's fleet-ci.yml. The all-green job reads needs
  // RESULTS and a skipped job stands down, so a deleted or conditioned-away
  // caller would leave the repo-owned checks as the whole gate - every
  // fleet gate silently dropped. Self mode is exempt (repo-platform's own
  // gating jobs are roster-pinned by check_ssot's all-green-roster rule).
  const owner = ownerPattern(ctx);
  if (ctx.mode === "render" && owner !== null) {
    const fleetCiUses = new RegExp(`^${owner}/repo-platform/\\.github/workflows/fleet-ci\\.yml@`);
    const fleetCaller = Object.values(jobs)
      .map((job) => (isRecord(job) ? job : {}))
      .find((job) => fleetCiUses.test(String(job.uses ?? "")));
    if (fleetCaller === undefined) {
      findings.push(
        error(
          "ci.yml: no job calls repo-platform's fleet-ci.yml reusable - " +
            "the fleet's gate jobs never run and the gate passes on " +
            "the repo-owned checks alone; restore the managed `ci` job " +
            "via a template sync",
        ),
      );
    } else if (fleetCaller.if !== undefined) {
      findings.push(
        error(
          "ci.yml: the fleet-ci caller job carries a job-level if: - a " +
            "skipped caller stands down from the all-green gate and " +
            "every fleet gate silently drops; remove the condition",
        ),
      );
    }
  }
  return findings;
}
