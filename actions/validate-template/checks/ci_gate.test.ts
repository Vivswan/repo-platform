import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadContext } from "../context.ts";
import type { Finding } from "../findings.ts";
import { checkCiGate } from "./ci_gate.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ANSWERS = "_commit: x\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n";

/** Runs the check over a render carrying `answers` and the given ci.yml
 *  (omitted when null); the result is the whole findings list, reduced to
 *  severity plus the message's leading clause, which is stable across
 *  wording of the remedy text. */
function gate(ci: string | null, answers: string | null = ANSWERS): [string, string][] {
  const root = mkdtempSync(join(tmpdir(), "ci-gate-"));
  roots.push(root);
  const files: Record<string, string> = {};
  if (answers !== null) files[".github/.copier-answers.yml"] = answers;
  if (ci !== null) files[".github/workflows/ci.yml"] = ci;
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return checkCiGate(loadContext(root, false)).map((f: Finding) => [
    f.severity,
    f.message.split(" - ")[0],
  ]);
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
    expected: [string, string][];
  }>([
    { reason: "the single-call gate shape is clean", ci: SINGLE_CALL, expected: [] },
    {
      reason: "no ci.yml is one error and nothing else",
      ci: null,
      expected: [["error", ".github/workflows/ci.yml is missing"]],
    },
    {
      reason: "an empty file is the no-jobs error alone",
      ci: "name: CI\n",
      expected: [["error", "ci.yml: exists but defines no jobs"]],
    },
    {
      reason: "a legacy public fan-out draws only the fan-out advisories (typography job present)",
      ci: LEGACY_FANOUT,
      expected: [
        ["advisory", "ci.yml: consider adding a `actionlint` job"],
        ["advisory", "ci.yml: consider adding a `gitleaks` job"],
        ["advisory", "ci.yml: consider adding a `yamllint` job"],
        ["advisory", "ci.yml: consider adding a `commit-names` job"],
        ["advisory", "ci.yml: consider adding a `dependency-review` job"],
      ],
    },
    {
      reason: "a private legacy fan-out silences dependency-review and demands typography",
      ci: LEGACY_FANOUT.replace("  typography:", "  lint:").replace(
        "needs: [typography]",
        "needs: [lint]",
      ),
      answers: `${ANSWERS}private: true\n`,
      expected: [
        ["error", "ci.yml: no `typography` job"],
        ["advisory", "ci.yml: consider adding a `actionlint` job"],
        ["advisory", "ci.yml: consider adding a `gitleaks` job"],
        ["advisory", "ci.yml: consider adding a `yamllint` job"],
        ["advisory", "ci.yml: consider adding a `commit-names` job"],
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
        ["error", "ci.yml: all-green `needs:` is missing job(s): ci"],
        ["error", "ci.yml: the all-green job must carry exactly `if: always()`"],
        ["error", "ci.yml: the all-green job has no judgment step"],
        ["error", "ci.yml: the fleet-ci caller job carries a job-level if:"],
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
      expected: [["error", "ci.yml: no job calls repo-platform's fleet-ci.yml reusable"]],
    },
  ])("$reason", ({ ci, answers, expected }) => {
    expect(gate(ci, answers)).toEqual(expected);
  });
});
