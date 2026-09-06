import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "../../../tests/shared/temp_dir.ts";
import { loadContext } from "../context.ts";
import { advisory, error, type Finding } from "../findings.ts";
import { checkCiGate } from "./ci_gate.ts";

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

const addJob = (job: string) => advisory(`ci.yml: consider adding a \`${job}\` job`);
const FANOUT_ADVISORIES = ["actionlint", "gitleaks", "yamllint", "commit-names"].map(addJob);

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

const LEGACY_GATE = [
  "  all-green:",
  "    if: always()",
  "    needs: [typography]",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: |",
  '          if [ "$RESULT" != "success" ]; then exit 1; fi',
  "",
];

const LEGACY_FANOUT = ["jobs:", "  typography:", "    runs-on: ubuntu-latest", ...LEGACY_GATE].join(
  "\n",
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
      reason: "a legacy public fan-out draws only the fan-out advisories (typography job present)",
      ci: LEGACY_FANOUT,
      expected: [...FANOUT_ADVISORIES, addJob("dependency-review")],
    },
    {
      reason: "a private legacy fan-out silences dependency-review and demands typography",
      ci: LEGACY_FANOUT.replace("  typography:", "  lint:").replace(
        "needs: [typography]",
        "needs: [lint]",
      ),
      answers: `${ANSWERS}private: true\n`,
      expected: [
        error(
          "ci.yml: no `typography` job - the no-look-alike-characters rule is unenforced; " +
            "add a job using Vivswan/repo-platform/actions/check-typography",
        ),
        ...FANOUT_ADVISORIES,
      ],
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
        "      - run: echo unjudged",
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
        error(
          "ci.yml: the all-green job has no judgment step - it must use repo-platform's " +
            "all-green action with `needs: ${{ toJSON(needs) }}` wired in (or the legacy inline " +
            "gate failing on non-success results) so failed, cancelled, and all-skipped runs " +
            "block the merge",
        ),
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
      expected: [
        error(
          "ci.yml: no job calls repo-platform's fleet-ci.yml reusable - the fleet's gate jobs " +
            "never run and the gate passes on the repo-owned checks alone; restore the managed " +
            "`ci` job via a template sync",
        ),
      ],
    },
  ])("$reason", ({ ci, answers, expected }) => {
    expect(gate(ci, answers)).toEqual(expected);
  });
});
