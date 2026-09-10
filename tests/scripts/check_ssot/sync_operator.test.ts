// The operator-verdict-only model (scripts/check/ssot/sync_operator.ts):
// the live workflow passes, and each way a step could print a target's
// detail into the public log is a mismatch.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SYNC_WORKFLOW,
  syncOperatorMismatches,
} from "../../../scripts/check/ssot/sync_operator.ts";

const live = readFileSync(SYNC_WORKFLOW, "utf-8");

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
        "      - uses: actions/checkout@v7\n        with:\n          repository: ${{ env.TARGET }}\n      - name: Print the verdict\n",
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
      reason: "a row timeout under the plan's (the re-run probe would die by a runner kill)",
      text: mutate(
        "    timeout-minutes: 60\n    steps:\n      - uses: actions/checkout@v7\n\n      - uses: oven-sh/setup-bun@v2",
        "    timeout-minutes: 30\n    steps:\n      - uses: actions/checkout@v7\n\n      - uses: oven-sh/setup-bun@v2",
      ),
      expected: "timeout-minutes at least the plan's (60)",
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
