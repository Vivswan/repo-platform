// This repository's two hand-written callers of reusable-pages.yml carry
// the same site configuration (the fleet reads its own from a registration
// this repository has none of): the rule pins their shared inputs equal.

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

function callerWith(text: string, caller: { file: string; job: string }): Record<string, unknown> {
  const jobs = asRecord(asRecord(parseYaml(text), caller.file).jobs, `${caller.file} jobs`);
  const job = asRecord(jobs[caller.job], `${caller.file} job ${caller.job}`);
  if (job.uses !== REUSABLE_PAGES) {
    throw new Error(
      `${caller.file}: job ${caller.job} does not call ${REUSABLE_PAGES} - anchor lost`,
    );
  }
  return asRecord(job.with ?? {}, `${caller.file} job ${caller.job} with`);
}

/** Every `with:` input except the push-only ones must sit on both callers
 *  with equal text, judged on the parsed workflows (exported for the
 *  forcing tests). */
export function pagesCallerMismatches(pushText: string, rebuildText: string): Mismatch[] {
  const push = callerWith(pushText, PAGES_CALLERS.push);
  const rebuild = callerWith(rebuildText, PAGES_CALLERS.rebuild);
  const mismatches: Mismatch[] = [];
  const keys = [...new Set([...Object.keys(push), ...Object.keys(rebuild)])].sort();
  for (const key of keys) {
    if (PUSH_ONLY_INPUTS.has(key)) {
      if (key in rebuild) {
        mismatches.push({
          file: PAGES_CALLERS.rebuild.file,
          expected: `no ${key} input on the ${PAGES_CALLERS.rebuild.job} job (the rebuild builds the default branch head)`,
          got: `${key}: ${String(rebuild[key])}`,
        });
      }
      continue;
    }
    const has = { push: key in push, rebuild: key in rebuild };
    if (has.push && has.rebuild) {
      if (String(push[key]) !== String(rebuild[key])) {
        mismatches.push({
          file: PAGES_CALLERS.rebuild.file,
          expected: `${key}: ${String(push[key])} (the ${PAGES_CALLERS.push.file} ${PAGES_CALLERS.push.job} job's value)`,
          got: `${key}: ${String(rebuild[key])}`,
        });
      }
      continue;
    }
    const missing = has.push ? PAGES_CALLERS.rebuild : PAGES_CALLERS.push;
    const present = has.push ? PAGES_CALLERS.push : PAGES_CALLERS.rebuild;
    mismatches.push({
      file: missing.file,
      expected: `a ${key} input on the ${missing.job} job, as ${present.file} passes`,
      got: "missing - the two deploys would build different sites",
    });
  }
  return mismatches;
}

export const pagesCallerRules: Rule[] = [
  {
    // Mounts, title, label, and domain live in two hand-written callers;
    // a change to one alone ships a nightly rebuild of a different site.
    name: "pages-callers-parity",
    run: () =>
      pagesCallerMismatches(read(PAGES_CALLERS.push.file), read(PAGES_CALLERS.rebuild.file)),
  },
];
