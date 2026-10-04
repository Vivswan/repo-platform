// GitHub's `steps` context carries two results per step, and only `conclusion` folds a continue-on-error failure into
// the success GitHub records for it: which field decides, the `::error::` lines the run shows, and the table bytes the
// summary shows are what the job's yaml cannot say about its judge. The script runs as the action runs it.

import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/judge-checks/judge-checks.ts");
const scratch = temp.dir("judge-checks-");
let serial = 0;

type StepResult = { outcome: string; conclusion: string };

interface Verdict {
  exitCode: number;
  stdout: string[];
  stderr: string;
  summary: string;
}

/** The context arrives as `toJSON(steps)` writes it: pretty-printed, one entry per step id. */
function judge(steps: Record<string, StepResult> | string): Verdict {
  const summary = join(scratch, `summary-${serial++}.md`);
  writeFileSync(summary, "");
  const result = boundedSpawnSync([process.execPath, SCRIPT], {
    env: {
      PATH: process.env.PATH,
      STEPS: typeof steps === "string" ? steps : JSON.stringify(steps, null, 2),
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.trimEnd().split("\n"),
    stderr: result.stderr,
    summary: readFileSync(summary, "utf8"),
  };
}

const HEADER = "## Standard checks\n\n| check | outcome | verdict |\n| --- | --- | --- |\n";
const ok: StepResult = { outcome: "success", conclusion: "success" };
const failed: StepResult = { outcome: "failure", conclusion: "failure" };
const cancelled: StepResult = { outcome: "cancelled", conclusion: "cancelled" };
const skipped: StepResult = { outcome: "skipped", conclusion: "skipped" };
/** What GitHub records for a failed step under continue-on-error. */
const advisory: StepResult = { outcome: "failure", conclusion: "success" };

test.each<{
  reason: string;
  steps: Record<string, StepResult> | string;
  expected: { exitCode: number; stdout: string[]; rows: string[] };
}>([
  {
    // A module or schedule gate skips a step by design: knip on a repository without the bun module, every check on
    // the nightly. Stood down is green, and a continue-on-error failure is the success GitHub concluded.
    reason: "every check green, stood down, or advisory passes",
    steps: { "checkout": ok, "plan": ok, "file-size": ok, "advisory": advisory, "knip": skipped },
    expected: {
      exitCode: 0,
      stdout: ["every check passed"],
      rows: [
        "| checkout | success | ok |",
        "| plan | success | ok |",
        "| file-size | success | ok |",
        "| advisory | failure | ok |",
        "| knip | skipped | stood down |",
      ],
    },
  },
  {
    reason: "every failed or cancelled check is named; green and stood-down ones are not",
    steps: {
      "typography": ok,
      "file-size": failed,
      "commit-names": failed,
      "yamllint": cancelled,
      "knip": skipped,
    },
    expected: {
      exitCode: 1,
      stdout: [
        "::error::check failed: file-size",
        "::error::check failed: commit-names",
        "::error::check failed: yamllint",
      ],
      rows: [
        "| typography | success | ok |",
        "| file-size | failure | FAILED |",
        "| commit-names | failure | FAILED |",
        "| yamllint | cancelled | FAILED |",
        "| knip | skipped | stood down |",
      ],
    },
  },
  {
    // GitHub resolves an input the caller never passed, or passed a mistyped expression, to the empty string with no
    // error; a judge fed nothing must not pass.
    reason: "an empty context is refused, never green",
    steps: "{}",
    expected: {
      exitCode: 1,
      stdout: ["::error::the steps context is empty: pass the job's toJSON(steps)"],
      rows: [],
    },
  },
])("the judge, executed: $reason", ({ steps, expected }) => {
  expect(judge(steps)).toEqual({
    exitCode: expected.exitCode,
    stdout: expected.stdout,
    stderr: "",
    summary: expected.rows.length === 0 ? "" : `${HEADER}${expected.rows.join("\n")}\n`,
  });
});
