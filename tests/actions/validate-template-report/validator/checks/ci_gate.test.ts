import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkCiGate } from "../../../../../actions/validate-template-report/validator/checks/ci_gate.ts";
import { loadContext } from "../../../../../actions/validate-template-report/validator/context.ts";
import {
  error,
  type Finding,
} from "../../../../../actions/validate-template-report/validator/findings.ts";
import { tempDirs } from "../../../../shared/temp_dir.ts";

const temp = tempDirs();

const ANSWERS = "_commit: x\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n";

/** Runs the check over a render carrying `answers` and the given ci.yml
 *  (omitted when null); the result is the whole findings list, remedy text
 *  included - a regression in the wording readers act on must fail here. */
function gate(ci: string | null, answers: string | null = ANSWERS): Finding[] {
  const root = temp.dir("ci-gate-");
  const files: Record<string, string> = {};
  if (answers !== null) files[".github/.copier-answers.yml"] = answers;
  if (ci !== null) files[".github/workflows/ci.yml"] = ci;
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return checkCiGate(loadContext(root, false));
}

const SINGLE_CALL = [
  "jobs:",
  "  checks:",
  "    uses: ./.github/workflows/checks.yml",
  "  ci:",
  "    uses: Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build",
  "  all-green:",
  "    needs: [checks, ci]",
  "    if: always()",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: Vivswan/repo-platform/actions/all-green@build",
  "        with:",
  "          needs: ${{ toJSON(needs) }}",
  "",
].join("\n");

/** A gate judging through an inline script, in a fan-out ci.yml with no
 *  fleet caller: both checks of the current shape speak at once. */
const INLINE_GATE_FANOUT = [
  "jobs:",
  "  typography:",
  "    runs-on: ubuntu-latest",
  "  all-green:",
  "    if: always()",
  "    needs: [typography]",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - env:",
  "          NEEDS: ${{ toJson(needs) }}",
  "        run: |",
  '          failed="$(jq -r \'to_entries[] | select(.value.result != "success") | .key\' <<< "$NEEDS")"',
  '          if [ -n "$failed" ]; then exit 1; fi',
  "",
].join("\n");

const NO_JUDGMENT = error(
  "ci.yml: the all-green job has no judgment step - the gate is repo-platform's all-green " +
    "action with `needs: ${{ toJSON(needs) }}` wired in, unconditioned and unsoftened; an inline " +
    "`run:` script or a disabled action step judges nothing this validator reads; run a template " +
    "sync to restore the managed ci.yml",
);
const NO_FLEET_CALLER = error(
  "ci.yml: no job calls repo-platform's fleet-ci.yml reusable - the fleet's gate jobs " +
    "never run and the gate passes on the repo-owned checks alone; restore the managed " +
    "`ci` job via a template sync",
);

describe("checkCiGate", () => {
  test.each<{
    reason: string;
    ci: string | null;
    answers?: string | null;
    expected: Finding[];
  }>([
    { reason: "the single-call gate shape is clean", ci: SINGLE_CALL, expected: [] },
    {
      reason: "no ci.yml is one error and nothing else",
      ci: null,
      expected: [
        error(
          ".github/workflows/ci.yml is missing - the template always generates and manages it; " +
            "restore the file from git history or run a template sync",
        ),
      ],
    },
    {
      reason: "an empty file is the no-jobs error alone",
      ci: "name: CI\n",
      expected: [
        error(
          "ci.yml: exists but defines no jobs - the file is empty or failed to parse as YAML; " +
            "restore the managed file via a template sync",
        ),
      ],
    },
    {
      reason:
        "an inline-script gate in a fan-out has no judgment step, and the fleet caller is missed",
      ci: INLINE_GATE_FANOUT,
      expected: [NO_JUDGMENT, NO_FLEET_CALLER],
    },
    {
      reason: "a run: step beside the action step is no finding: the action judges",
      ci: SINGLE_CALL.replace(
        "    steps:\n",
        "    steps:\n      - run: echo ${{ toJSON(needs) }}\n",
      ),
      expected: [],
    },
    {
      reason: "a logging run: step beside a disabled action step is the one judgment error",
      ci: SINGLE_CALL.replace(
        "      - uses: Vivswan/repo-platform/actions/all-green@build\n",
        "      - run: echo diagnostics\n      - if: false\n        uses: Vivswan/repo-platform/actions/all-green@build\n",
      ),
      expected: [NO_JUDGMENT],
    },
    {
      reason:
        "a gutted gate reports every shape error at once, and the fleet-caller check still runs",
      ci: [
        "jobs:",
        "  checks:",
        "    uses: ./.github/workflows/checks.yml",
        "  ci:",
        "    if: github.event_name == 'push'",
        "    uses: Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build",
        "  all-green:",
        "    needs: [checks]",
        "    if: success()",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "",
      ].join("\n"),
      expected: [
        error(
          "ci.yml: all-green `needs:` is missing job(s): ci - those jobs cannot gate merges; " +
            "add them to the all-green job's needs list",
        ),
        error(
          "ci.yml: the all-green job must carry exactly `if: always()` - without it a failed " +
            "dependency skips the gate instead of failing it, and extra conditions weaken the gate",
        ),
        NO_JUDGMENT,
        error(
          "ci.yml: the fleet-ci caller job carries a job-level if: - a skipped caller stands " +
            "down from the all-green gate and every fleet gate silently drops; remove the condition",
        ),
      ],
    },
    {
      reason:
        "an unhealed owner stands the fleet-caller check down (its cause is reported elsewhere)",
      ci: SINGLE_CALL.replace("Vivswan/repo-platform/.github/workflows/fleet-ci.yml", "x/y.yml"),
      answers: "_commit: x\n_src_path: gh:Vivswan/repo-platform\n",
      expected: [],
    },
    {
      reason: "a pinned owner rejects another owner's fleet-ci caller",
      ci: SINGLE_CALL.replace("Vivswan/repo-platform/.github", "evil/repo-platform/.github"),
      expected: [NO_FLEET_CALLER],
    },
  ])("$reason", ({ ci, answers, expected }) => {
    expect(gate(ci, answers)).toEqual(expected);
  });
});
