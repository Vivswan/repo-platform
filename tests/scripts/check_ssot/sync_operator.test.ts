// The operator-verdict-only model (scripts/check/ssot/sync_operator.ts):
// the live workflow passes, and each way a step could print a target's
// detail into the public log is a mismatch.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rowBudgetMinutes } from "../../../.github/scripts/sync/row_budget.ts";
import {
  SYNC_WORKFLOW,
  syncOperatorMismatches,
} from "../../../scripts/check/ssot/sync_operator.ts";

const live = readFileSync(SYNC_WORKFLOW, "utf-8");

// The operator's pinned action lines, spelled exactly as the workflow does.
const CHECKOUT = "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const SETUP_BUN =
  "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0";

describe("syncOperatorMismatches", () => {
  test("the live sync-repos.yml is judged clean - the control for every red case below", () => {
    expect(syncOperatorMismatches(live)).toEqual([]);
  });

  const mutate = (from: string, to: string) => {
    expect(live).toContain(from);
    return live.replace(from, to);
  };

  test.each([
    {
      reason: "a run step that prints (its redirect dropped)",
      text: mutate(
        'run: bun .github/scripts/fleet/discover_repos.ts > "$RUNNER_TEMP/discover.log" 2>&1',
        "run: bun .github/scripts/fleet/discover_repos.ts",
      ),
      expected: "redirected to a $RUNNER_TEMP file",
    },
    {
      reason: "a redirect to the workspace instead of the runner scratch",
      text: mutate('> "$RUNNER_TEMP/sync.log" 2>&1', "> sync.log 2>&1"),
      expected: "redirected to a $RUNNER_TEMP file",
    },
    {
      reason: "a matrix carrying repository slugs",
      text: mutate(
        "        row: ${{ fromJSON(needs.plan.outputs.indexes) }}",
        "        repo: ${{ fromJSON(needs.plan.outputs.repos) }}",
      ),
      expected: "row indexes alone",
    },
    {
      reason: "a job name carrying the repository",
      text: mutate(
        "name: sync (row ${{ matrix.row }})",
        "name: sync (${{ steps.target.outputs.repo }})",
      ),
      expected: "an index, never a repository",
    },
    {
      reason: "the target name declared in a step's env (the runner prints it)",
      text: mutate(
        "          BUILD: ${{ needs.plan.outputs.build }}\n        run: >-\n          bun .github/scripts/sync/writer/sync.ts",
        "          BUILD: ${{ needs.plan.outputs.build }}\n          TARGET: ${{ steps.target.outputs.repo }}\n        run: >-\n          bun .github/scripts/sync/writer/sync.ts",
      ),
      expected: "no TARGET in a sync step's env",
    },
    {
      reason: "a second command chained in front of the redirect",
      text: mutate(
        'run: bun .github/scripts/sync/deliver.ts > "$RUNNER_TEMP/deliver-stdio.log" 2>&1',
        'run: cat target/README.md; bun .github/scripts/sync/deliver.ts > "$RUNNER_TEMP/deliver-stdio.log" 2>&1',
      ),
      expected: "one bun command redirected",
    },
    {
      reason: "an action outside the allow-list (its script prints outside the redirect rule)",
      text: mutate(
        "      - name: Print the verdict\n",
        "      - uses: actions/github-script@v7\n        with:\n          script: console.log(require('fs').readFileSync('target/README.md', 'utf8'))\n      - name: Print the verdict\n",
      ),
      expected: "using one of actions/checkout@, oven-sh/setup-bun@",
    },
    {
      reason: "a checkout action aimed at the target (git's diagnostics would print)",
      text: mutate(
        "      - name: Print the verdict\n",
        `${CHECKOUT}\n        with:\n          repository: \${{ env.TARGET }}\n      - name: Print the verdict\n`,
      ),
      expected: "no repository: on a checkout action",
    },
    {
      reason: "the row job's selector losing the call scope the plan's selector reads",
      text: mutate(
        "          TARGET_SHA: ${{ inputs.sha }}\n        run: bun .github/scripts/fleet/select_sync_repos.ts > ",
        "        run: bun .github/scripts/fleet/select_sync_repos.ts > ",
      ),
      expected: "the plan's exact env",
    },
    {
      reason:
        "a row timeout under its budget (the runner would kill the row before the failure report is filed)",
      text: mutate(
        `    timeout-minutes: 105\n    steps:\n${CHECKOUT}\n\n${SETUP_BUN}`,
        `    timeout-minutes: 60\n    steps:\n${CHECKOUT}\n\n${SETUP_BUN}`,
      ),
      expected: `timeout-minutes at least ${rowBudgetMinutes(10)}`,
    },
    {
      reason: "a writer timeout raised without the row's following it",
      text: mutate(
        "        timeout-minutes: 10\n        env:\n          BUILD:",
        "        timeout-minutes: 30\n        env:\n          BUILD:",
      ),
      expected: `timeout-minutes at least ${rowBudgetMinutes(30)}`,
    },
    {
      reason: "the writer step losing its timeout (the budget's writer term)",
      text: mutate(
        "        timeout-minutes: 10\n        env:\n          BUILD:",
        "        env:\n          BUILD:",
      ),
      expected: "the writer step carrying its own timeout-minutes",
    },
    {
      reason: "a second printer step",
      text: mutate(
        "        run: bun .github/scripts/sync/verdict.ts row\n",
        "        run: bun .github/scripts/sync/verdict.ts row\n      - run: bun .github/scripts/sync/verdict.ts row\n",
      ),
      expected: "exactly one sync step running",
    },
  ])("$reason is the one mismatch", ({ text, expected }) => {
    const got = syncOperatorMismatches(text).map((m) => m.expected);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(expected);
  });

  test("the resolver's own env is judged too: a TARGET there names that step", () => {
    const text = mutate(
      "          PLANNED: ${{ needs.plan.outputs.count }}\n        run: bun .github/scripts/sync/resolve_row.ts",
      "          PLANNED: ${{ needs.plan.outputs.count }}\n          TARGET: ${{ steps.target.outputs.repo }}\n        run: bun .github/scripts/sync/resolve_row.ts",
    );
    expect(syncOperatorMismatches(text)).toEqual([
      {
        file: SYNC_WORKFLOW,
        expected:
          "no TARGET in a sync step's env (the runner prints step env; the name rides GITHUB_ENV)",
        got: 'sync step "Resolve the row\'s target" declares TARGET',
      },
    ]);
  });

  test("a target checkout before the resolver is refused: the masks would not exist yet", () => {
    const resolver = live.slice(
      live.indexOf("      # The only step that sees the name in the clear"),
      live.indexOf("      # A captured clone, not actions/checkout"),
    );
    const checkout = live.slice(
      live.indexOf("      # A captured clone, not actions/checkout"),
      live.indexOf("      # The one writer step"),
    );
    const swapped = live.replace(resolver + checkout, checkout + resolver);
    expect(swapped).not.toBe(live);
    expect(syncOperatorMismatches(swapped).map((m) => m.expected)).toEqual([
      "a sync step running bun .github/scripts/sync/checkout_target.ts AFTER the resolver registered the masks",
    ]);
  });

  test("a workflow without a sync job is anchor-lost, never a pass", () => {
    expect(() => syncOperatorMismatches("jobs:\n  plan:\n    steps: []\n")).toThrow("anchor lost");
  });
});
