// This repository's two hand-written callers of reusable-pages.yml carry
// the same site configuration (the fleet reads its own from a registration
// this repository has none of): the rule pins their shared inputs equal,
// and the docs PR check's pages-site step to the same mounts and title.

import { parse as parseYaml } from "yaml";
import type { Mismatch } from "./comparison.ts";
import { asRecord, read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The two callers: the push deploy in ci.yml and the nightly rebuild and
 *  dispatch in docs-site.yml. `sha` is the push deploy's alone (the judged
 *  commit); the rebuild builds the default branch head, so it is the one
 *  input excused from the parity. */
export const PAGES_CALLERS = {
  push: { file: ".github/workflows/ci.yml", job: "docs-site" },
  rebuild: { file: ".github/workflows/docs-site.yml", job: "deploy" },
} as const;
export const REUSABLE_PAGES = "./.github/workflows/reusable-pages.yml";
const PUSH_ONLY_INPUTS = new Set(["sha"]);

/** The docs PR check: docs-site.yml's check job, the one step calling the
 *  pages-site action with check true. Its site inputs (the action's
 *  hyphenated names) must carry the push deploy's values under the
 *  workflow's names, so the PR judges the site the deploy builds. */
export const PAGES_CHECK = { file: ".github/workflows/docs-site.yml", job: "check" } as const;
const PAGES_SITE_ACTION = "actions/pages-site@";
const CHECK_INPUTS: Record<string, string> = {
  mounts: "mounts",
  "site-title": "site_title",
  "docs-dir": "docs_dir",
};

/** One side of a comparison: a `with:` block and how a message names it. */
interface Side {
  file: string;
  where: string;
  with: Record<string, unknown>;
}

function callerSide(text: string, caller: { file: string; job: string }): Side {
  const jobs = asRecord(asRecord(parseYaml(text), caller.file).jobs, `${caller.file} jobs`);
  const job = asRecord(jobs[caller.job], `${caller.file} job ${caller.job}`);
  if (job.uses !== REUSABLE_PAGES) {
    throw new Error(
      `${caller.file}: job ${caller.job} does not call ${REUSABLE_PAGES} - anchor lost`,
    );
  }
  return {
    file: caller.file,
    where: `${caller.job} job`,
    with: asRecord(job.with ?? {}, `${caller.file} job ${caller.job} with`),
  };
}

function checkStepSide(text: string): Side {
  const jobs = asRecord(
    asRecord(parseYaml(text), PAGES_CHECK.file).jobs,
    `${PAGES_CHECK.file} jobs`,
  );
  const job = asRecord(jobs[PAGES_CHECK.job], `${PAGES_CHECK.file} job ${PAGES_CHECK.job}`);
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const checks = steps
    .map((step) => asRecord(step, `${PAGES_CHECK.file} job ${PAGES_CHECK.job} step`))
    .filter((step) => typeof step.uses === "string" && step.uses.includes(PAGES_SITE_ACTION))
    .map((step) => asRecord(step.with ?? {}, `${PAGES_CHECK.file} pages-site step with`))
    .filter((with_) => String(with_.check) === "true");
  if (checks.length !== 1) {
    throw new Error(
      `${PAGES_CHECK.file}: job ${PAGES_CHECK.job} has ${checks.length} pages-site steps with check true, not one - anchor lost`,
    );
  }
  return {
    file: PAGES_CHECK.file,
    where: `${PAGES_CHECK.job} job's pages-site step`,
    with: checks[0] as Record<string, unknown>,
  };
}

/** One input pair: equal text on both sides, or absent from both. The
 *  reference side's value is the expected one; `consequence` finishes the
 *  missing-input message. */
function inputMismatch(
  reference: Side,
  referenceKey: string,
  other: Side,
  otherKey: string,
  consequence: string,
): Mismatch | undefined {
  const has = { reference: referenceKey in reference.with, other: otherKey in other.with };
  if (has.reference && has.other) {
    const expected = String(reference.with[referenceKey]);
    const got = String(other.with[otherKey]);
    if (expected === got) return undefined;
    return {
      file: other.file,
      expected: `${otherKey}: ${expected} (the ${reference.file} ${reference.where}'s ${referenceKey})`,
      got: `${otherKey}: ${got}`,
    };
  }
  if (!has.reference && !has.other) return undefined;
  const [missing, missingKey, present, presentKey] = has.reference
    ? [other, otherKey, reference, referenceKey]
    : [reference, referenceKey, other, otherKey];
  return {
    file: missing.file,
    expected: `a ${missingKey} input on the ${missing.where}, as ${present.file} passes ${presentKey}`,
    got: `missing - ${consequence}`,
  };
}

/** Every `with:` input except the push-only ones must sit on both callers
 *  with equal text, judged on the parsed workflows (exported for the
 *  forcing tests). */
export function pagesCallerMismatches(pushText: string, rebuildText: string): Mismatch[] {
  const push = callerSide(pushText, PAGES_CALLERS.push);
  const rebuild = callerSide(rebuildText, PAGES_CALLERS.rebuild);
  const mismatches: Mismatch[] = [];
  const keys = [...new Set([...Object.keys(push.with), ...Object.keys(rebuild.with)])].sort();
  for (const key of keys) {
    if (PUSH_ONLY_INPUTS.has(key)) {
      if (key in rebuild.with) {
        mismatches.push({
          file: rebuild.file,
          expected: `no ${key} input on the ${rebuild.where} (the rebuild builds the default branch head)`,
          got: `${key}: ${String(rebuild.with[key])}`,
        });
      }
      continue;
    }
    const mismatch = inputMismatch(
      push,
      key,
      rebuild,
      key,
      "the two deploys would build different sites",
    );
    if (mismatch) mismatches.push(mismatch);
  }
  return mismatches;
}

/** The check step's site inputs against the push deploy's: each mapped
 *  pair sits on both sides with equal text, or on neither. */
export function pagesCheckMismatches(pushText: string, checkText: string): Mismatch[] {
  const push = callerSide(pushText, PAGES_CALLERS.push);
  const check = checkStepSide(checkText);
  const mismatches: Mismatch[] = [];
  for (const [checkKey, pushKey] of Object.entries(CHECK_INPUTS)) {
    const mismatch = inputMismatch(
      push,
      pushKey,
      check,
      checkKey,
      "the PR check would judge a different site than the deploy builds",
    );
    if (mismatch) mismatches.push(mismatch);
  }
  return mismatches;
}

export const pagesCallerRules: Rule[] = [
  {
    // Mounts, title, label, and domain live in two hand-written callers;
    // a change to one alone ships a nightly rebuild of a different site.
    name: "pages-callers-parity",
    run: () => {
      const push = read(PAGES_CALLERS.push.file);
      const rebuild = read(PAGES_CALLERS.rebuild.file);
      return [...pagesCallerMismatches(push, rebuild), ...pagesCheckMismatches(push, rebuild)];
    },
  },
];
