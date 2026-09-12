// A docs check over a different include set than the deploy passes PRs the deploy then breaks on.

import { constStringValue } from "../../lib/ts_extract.ts";
import { canonical, type Mismatch } from "./comparison.ts";
import { asRecord, ciJobs, read, repoCi } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

export const DOCS_CHECK_SCRIPT = "scripts/docs_check.ts";
const CI = ".github/workflows/ci.yml";

function configOf(carrier: Record<string, unknown>, where: string): unknown {
  const config = asRecord(carrier.with ?? {}, `${where} with`).config;
  if (typeof config !== "string") {
    throw new Error(`${where}: anchor for the config input not found (no with.config string)`);
  }
  try {
    return JSON.parse(config);
  } catch {
    throw new Error(`${where}: with.config is not JSON: ${config}`);
  }
}

function docsCheckStep(jobs: Record<string, unknown>): Record<string, unknown> {
  const job = asRecord(jobs["docs-check"] ?? {}, `${CI} docs-check`);
  const steps = Array.isArray(job.steps) ? (job.steps as unknown[]) : [];
  const step = steps.find(
    (candidate) => asRecord(candidate, `${CI} docs-check steps`).uses === "./actions/pages-site",
  );
  if (step === undefined) {
    throw new Error(
      `${CI} docs-check: anchor for the pages-site step not found (no uses: ./actions/pages-site)`,
    );
  }
  return asRecord(step, `${CI} docs-check pages-site step`);
}

export function siteConfigMismatches(
  ci: Record<string, unknown>,
  docsCheckSource: string,
): Mismatch[] {
  const jobs = ciJobs(ci, CI);
  const deploy = canonical(configOf(asRecord(jobs.site ?? {}, `${CI} site`), `${CI} site`));
  const copies: [string, unknown][] = [
    [`${CI} docs-check`, configOf(docsCheckStep(jobs), `${CI} docs-check pages-site step`)],
    [
      DOCS_CHECK_SCRIPT,
      JSON.parse(
        constStringValue(docsCheckSource, "SITE_CONFIG", {
          where: DOCS_CHECK_SCRIPT,
          what: "the local docs check's site configuration",
        }),
      ),
    ],
  ];
  return copies.flatMap(([file, config]) =>
    canonical(config) === deploy
      ? []
      : [{ file, expected: `the site job's config ${deploy}`, got: canonical(config) }],
  );
}

export const siteConfigRules: Rule[] = [
  {
    name: "site-config-parity",
    run: () => siteConfigMismatches(repoCi(), read(DOCS_CHECK_SCRIPT)),
  },
];
