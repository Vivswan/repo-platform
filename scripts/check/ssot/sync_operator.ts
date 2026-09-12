// The sync operator's log shape (docs/sync.md, "The operator"): the row
// job's steps print nothing but the vocabulary, the matrix carries row
// indexes and the plan's opaque keys, the row job runs no probe of its own,
// and the resolve step is the boundary the target's name crosses behind a mask.

import { parse as parseYaml } from "yaml";
import { rowBudgetMinutes } from "../../../.github/scripts/sync/row_budget.ts";
import type { Mismatch } from "./comparison.ts";
import { read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

export const SYNC_WORKFLOW = ".github/workflows/sync-repos.yml";
export const PRINTER = "bun .github/scripts/sync/verdict.ts";
export const RESOLVER = "bun .github/scripts/sync/resolve_row.ts";
export const CHECKOUT = "bun .github/scripts/sync/checkout_target.ts";
export const SELECTOR = "bun .github/scripts/fleet/select_sync_repos.ts";
export const DISCOVERY = "bun .github/scripts/fleet/discover_repos.ts";
export const WRITER = "bun .github/scripts/sync/writer/sync.ts";
/** The argument character class admits no shell operator, so nothing can put a second command's output in front of the redirect. */
export const REDIRECTED =
  /^bun (\.github\/scripts\/[A-Za-z0-9_./-]+\.ts|install)( [A-Za-z0-9_./"$=:+-]+)* > "\$RUNNER_TEMP\/[A-Za-z0-9._-]+" 2>&1$/;
/** The actions a row job may `uses:`; anything else runs code whose output
 *  the redirect rule cannot see. */
export const ROW_ACTIONS = ["actions/checkout@", "oven-sh/setup-bun@"];
/** Both fleet writers' row matrices: the `include` word in the workflow, the rows from the plan's
 *  output alone (a literal could carry slugs; the word in the output could match a masked name). */
export const keyedMatrix = (planJob: string) => ({
  include: `\${{ fromJSON(needs.${planJob}.outputs.matrix) }}`,
});
/** Both fleet writers' resolver steps: the row's key, what keyed it, and the listing it resolves against. */
export const RESOLVER_ENV = {
  ROW_KEY: "${{ matrix.key }}",
  PAT: "${{ secrets.REPO_PLATFORM_TOKEN }}",
  GH_TOKEN: "${{ secrets.REPO_PLATFORM_TOKEN }}",
  OWNER: "${{ github.repository_owner }}",
};
/** A mapping as the rules compare and report it: keys sorted, so declaration order never counts. */
export const canonical = (value: unknown): string => {
  const record = mapping(value);
  return JSON.stringify(record, Object.keys(record).sort());
};

type Step = Record<string, unknown>;

const mapping = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const steps = (job: Record<string, unknown>): Step[] =>
  Array.isArray(job.steps) ? (job.steps as unknown[]).map(mapping) : [];

const runOf = (step: Step) => String(step.run ?? "").trim();

export function syncOperatorMismatches(text: string, rel = SYNC_WORKFLOW): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const jobs = mapping(mapping(parseYaml(text)).jobs);
  const plan = mapping(jobs.plan);
  const sync = mapping(jobs.sync);
  const rowSteps = steps(sync);
  if (rowSteps.length === 0) throw new Error(`${rel}: no sync job steps - anchor lost`);

  const matrix = mapping(sync.strategy).matrix;
  if (canonical(matrix) !== canonical(keyedMatrix("plan"))) {
    mismatches.push({
      file: rel,
      expected: `the plan's matrix of row indexes and keys alone: matrix: ${JSON.stringify(keyedMatrix("plan"))}`,
      got: matrix === undefined ? "no matrix" : `matrix: ${JSON.stringify(matrix)}`,
    });
  }
  // The selector is the one producer that keys rows without naming them, so the plan's matrix
  // output may come from nowhere else.
  const planSelector = steps(plan).find((step) => runOf(step).startsWith(SELECTOR));
  if (planSelector === undefined) throw new Error(`${rel}: no plan selector step - anchor lost`);
  const selectorMatrix = `\${{ steps.${String(planSelector.id ?? "")}.outputs.matrix }}`;
  const planMatrix = mapping(plan.outputs).matrix;
  if (planMatrix !== selectorMatrix) {
    mismatches.push({
      file: rel,
      expected: `the plan's matrix output wired to the selector's (matrix: ${selectorMatrix})`,
      got: planMatrix === undefined ? "no matrix output" : `matrix: ${JSON.stringify(planMatrix)}`,
    });
  }
  if (String(sync.name ?? "") !== "sync (row ${{ matrix.row }})") {
    mismatches.push({
      file: rel,
      expected: "the row job named sync (row ${{ matrix.row }}) - an index, never a repository",
      got: `name: ${String(sync.name ?? "(none)")}`,
    });
  }

  let printers = 0;
  let resolverAt = -1;
  let checkoutAt = -1;
  rowSteps.forEach((step, index) => {
    const run = runOf(step);
    const name = String(step.name ?? step.id ?? index + 1);
    // Every step, the resolver and the actions included: the runner prints
    // declared env for all of them alike.
    for (const key of Object.keys(mapping(step.env))) {
      if (key === "TARGET" || key === "TARGET_PRIVATE") {
        mismatches.push({
          file: rel,
          expected: `no ${key} in a sync step's env (the runner prints step env; the name rides GITHUB_ENV)`,
          got: `sync step "${name}" declares ${key}`,
        });
      }
    }
    if (run === "") {
      const uses = String(step.uses ?? "");
      if (!ROW_ACTIONS.some((prefix) => uses.startsWith(prefix))) {
        mismatches.push({
          file: rel,
          expected: `sync step "${name}" using one of ${ROW_ACTIONS.join(", ")} (any other action prints outside the redirect rule)`,
          got: uses === "" ? "a step with neither run nor uses" : `uses: ${uses}`,
        });
      }
      if ("repository" in mapping(step.with)) {
        mismatches.push({
          file: rel,
          expected: `no repository: on a checkout action (the target is cloned by ${CHECKOUT}, its output captured)`,
          got: `sync step "${name}" checks out another repository`,
        });
      }
      return;
    }
    if (run === `${PRINTER} row`) {
      printers++;
      return;
    }
    if (run === RESOLVER) {
      resolverAt = index;
      if (canonical(step.env) !== canonical(RESOLVER_ENV)) {
        mismatches.push({
          file: rel,
          expected: `the resolver step's env exactly ${JSON.stringify(RESOLVER_ENV)} (the row's key, what keyed it, and the listing it resolves against)`,
          got: canonical(step.env),
        });
      }
      return;
    }
    if (run.startsWith(CHECKOUT)) checkoutAt = index;
    if (!REDIRECTED.test(run)) {
      mismatches.push({
        file: rel,
        expected: `sync step "${name}" as one bun command redirected to a $RUNNER_TEMP file (> "$RUNNER_TEMP/<name>" 2>&1), the printer, or the resolver`,
        got: "a run step that can print to the public log",
      });
    }
  });
  if (printers !== 1) {
    mismatches.push({
      file: rel,
      expected: `exactly one sync step running ${PRINTER} row`,
      got: `${printers} printer step(s)`,
    });
  }
  if (resolverAt === -1) {
    mismatches.push({
      file: rel,
      expected: `a sync step running ${RESOLVER} before the target checkout`,
      got: "no resolver step",
    });
  }
  if (checkoutAt === -1 || checkoutAt < resolverAt) {
    mismatches.push({
      file: rel,
      expected: `a sync step running ${CHECKOUT} AFTER the resolver registered the masks`,
      got:
        checkoutAt === -1 ? "no target checkout step" : "the target checkout before the resolver",
    });
  }

  const planPrinter = steps(plan).some((step) => runOf(step) === `${PRINTER} plan`);
  if (!planPrinter) {
    mismatches.push({
      file: rel,
      expected: `a plan step running ${PRINTER} plan`,
      got: "no plan printer step",
    });
  }
  // The plan probed once; a row that probes again costs N selections per run and could move a
  // row onto another repository. The resolver's one listing is the row's whole network.
  for (const [label, command] of [
    ["discovery", DISCOVERY],
    ["selection", SELECTOR],
  ] as const) {
    if (rowSteps.some((step) => runOf(step).startsWith(command))) {
      mismatches.push({
        file: rel,
        expected: `no ${label} in the sync job (${command} runs in the plan alone; the resolver lists once)`,
        got: `a sync step running the ${label}`,
      });
    }
  }
  const writer = rowSteps.find((step) => runOf(step).startsWith(WRITER));
  if (writer === undefined) throw new Error(`${rel}: no writer step - anchor lost`);
  const writerTimeout = Number(writer["timeout-minutes"]);
  if (!Number.isFinite(writerTimeout)) {
    mismatches.push({
      file: rel,
      expected: "the writer step carrying its own timeout-minutes (the row budget's writer term)",
      got: `timeout-minutes: ${String(writer["timeout-minutes"] ?? "(none)")} on the writer step`,
    });
    return mismatches;
  }
  const budget = rowBudgetMinutes(writerTimeout);
  const rowTimeout = Number(sync["timeout-minutes"]);
  if (!(rowTimeout >= budget)) {
    mismatches.push({
      file: rel,
      expected: `the sync job's timeout-minutes at least ${budget}, the row budget row_budget.ts sums from its steps' bounds and the writer step's ${writerTimeout}: a row killed at its timeout files no failure report`,
      got: `timeout-minutes: ${String(sync["timeout-minutes"] ?? "(none)")}`,
    });
  }
  return mismatches;
}

export const syncOperatorRules: Rule[] = [
  {
    // The operator prints only its vocabulary: redaction is the job's
    // shape, not a per-step discipline, so the shape is pinned.
    name: "operator-verdict-only",
    run: () => syncOperatorMismatches(read(SYNC_WORKFLOW)),
  },
];
