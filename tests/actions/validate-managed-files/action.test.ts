// The report step never fails, so a blocking verdict is readable in the PR conversation before the caller fails the job.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classify,
  type Integrity,
  readVerdict,
  writeVerdict,
} from "../../../actions/validate-managed-files/src/verdict";
import { loadAction } from "../../shared/action_step";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const ACTION = join(import.meta.dir, "../../../actions/validate-managed-files");
const RUN_URL = "https://example.invalid/run/1";
const HEADING = "### Managed files check\n\n";

// The sticky-comment steps gate on `report`'s two values and are continue-on-error, so a value the script
// spells one way and the manifest another is a comment never posted or never deleted, green. Both literals
// are read from the manifest's `if` lines, never spelled here.
function commentGates(): { post: string; remove: string } {
  const action = loadAction("actions/validate-managed-files/action.yml");
  const gateOf = (id: string): string => {
    const step = action.runs.steps.find((s) => s.id === id);
    const match = /steps\.report\.outputs\.report == '([a-z]+)'/.exec(String(step?.if));
    if (match === null)
      throw new Error(`step '${id}' does not gate on steps.report.outputs.report`);
    return match[1];
  };
  return { post: gateOf("post-comment"), remove: gateOf("delete-comment") };
}
const REPORT = commentGates();

const fakeValidator = `import { writeFileSync } from "node:fs";
if (!process.env.FAKE_SKIP_REPORT) {
  writeFileSync(process.env.FINDINGS_FILE, process.env.FAKE_FINDINGS ?? "");
}
if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);
process.exit(Number(process.env.FAKE_EXIT ?? "0"));
`;

const read = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

interface Scenario {
  env?: Record<string, string>;
  verdict?: Integrity | "absent" | "garbage";
  clearOutcome?: string;
}

interface Outcome {
  runExit: number | null;
  verdict: Integrity | null;
  outputs: string;
  summary: string;
  comment: string;
}

function play(scenario: Scenario): Outcome {
  const root = temp.dir("validate-managed-action-");
  const actionPath = join(root, "action");
  mkdirSync(join(actionPath, "validator"), { recursive: true });
  for (const name of ["src/run.ts", "src/report.ts", "src/verdict.ts"]) {
    mkdirSync(join(actionPath, "src"), { recursive: true });
    writeFileSync(
      join(actionPath, name),
      readFileSync(join(ACTION, name), "utf8").replaceAll("../../shared/", `${ACTION}/../shared/`),
    );
  }
  writeFileSync(join(actionPath, "validator", "validate_managed_files.ts"), fakeValidator);
  const scratch = join(root, "scratch");
  const verdictFile = join(root, "verdict.json");
  const outputs = join(root, "outputs.txt");
  const summary = join(root, "summary.md");
  const comment = join(root, "comment.md");
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  writeFileSync(outputs, "");
  writeFileSync(summary, "");
  let runExit: number | null = null;
  if (scenario.verdict === undefined) {
    const result = boundedSpawnSync([process.execPath, join(actionPath, "src/run.ts")], {
      cwd: checkout,
      env: {
        ...process.env,
        ACTION_BUN: process.execPath,
        ACTION_PATH: actionPath,
        FILES_CONFIG: join(root, "files.yml"),
        REPOSITORY_PRIVATE: "false",
        SCRATCH_DIR: scratch,
        VERDICT_FILE: verdictFile,
        ...scenario.env,
      },
    });
    runExit = result.exitCode;
  } else if (scenario.verdict === "garbage") {
    writeFileSync(verdictFile, '{"kind": "clean", "extra": 1}\n');
  } else if (scenario.verdict !== "absent") {
    writeVerdict(verdictFile, scenario.verdict);
  }
  const report = boundedSpawnSync([process.execPath, join(actionPath, "src/report.ts")], {
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: outputs,
      COMMENT_FILE: comment,
      VERDICT: verdictFile,
      CLEAR_OUTCOME: scenario.clearOutcome ?? "success",
      RUN_URL,
    },
  });
  expect(report.exitCode).toBe(0);
  return {
    runExit,
    verdict: existsSync(verdictFile) ? (JSON.parse(read(verdictFile)) as Integrity) : null,
    outputs: read(outputs),
    summary: read(summary),
    comment: read(comment),
  };
}

// The remedy is the operator's whole instruction on a red check; the kind-change hold it names is write_link.ts's rule.
const REMEDY =
  "Managed content changed outside a sync. Restore the file from git history, or re-run the sync: it rewrites managed files whole but holds a path whose kind changed (a link in a file's place) for this repository to restore. This FAILS the check.";
const notJudged = (text: string) =>
  `${HEADING}Not judged: ${text}. See the [run log](${RUN_URL}). This FAILS the check.\n`;
const BLOCKED = `integrity=failure\nreport=${REPORT.post}\n`;

describe("the validator's classification reaches the report as one verdict", () => {
  // The exit and the findings file are two witnesses: a validator that exits 0 with findings, or nonzero with
  // none, is a broken run, and reading either witness alone would pass it.
  const FINDINGS = "#### Errors (1)\n\n- ci.yml: content does not match";
  test.each<{
    reason: string;
    env: Record<string, string>;
    runExit: number;
    verdict: Integrity;
    outputs: string;
    comment: string;
  }>([
    {
      reason: "a clean run passes and clears a stale comment",
      env: {},
      runExit: 0,
      verdict: { kind: "clean" },
      outputs: `integrity=success\nreport=${REPORT.remove}\n`,
      comment: `${HEADING}Passed - this repository matches the state its last sync recorded.\n`,
    },
    {
      reason: "findings block, carry the remedy, and are posted",
      env: { FAKE_EXIT: "1", FAKE_FINDINGS: `${FINDINGS}\n` },
      runExit: 1,
      verdict: { kind: "findings", findings: FINDINGS },
      outputs: BLOCKED,
      comment: `${HEADING}${FINDINGS}\n${REMEDY}\n`,
    },
    {
      reason: "a validator that exited 0 yet reported findings is not judged",
      env: { FAKE_FINDINGS: "- x\n" },
      runExit: 1,
      verdict: { kind: "not-judged", reason: "the validator exited 0 yet reported findings" },
      outputs: BLOCKED,
      comment: notJudged("the validator exited 0 yet reported findings"),
    },
    {
      reason: "a validator that exited nonzero without a finding is not judged",
      env: { FAKE_EXIT: "1" },
      runExit: 1,
      verdict: { kind: "not-judged", reason: "the validator exited 1 without reporting a finding" },
      outputs: BLOCKED,
      comment: notJudged("the validator exited 1 without reporting a finding"),
    },
    {
      reason: "a validator that crashed before reporting is not judged",
      env: { FAKE_EXIT: "2", FAKE_SKIP_REPORT: "1" },
      runExit: 1,
      verdict: { kind: "not-judged", reason: "the validator exited 2 before reporting" },
      outputs: BLOCKED,
      comment: notJudged("the validator exited 2 before reporting"),
    },
    {
      reason: "a validator killed by a signal is not judged",
      env: { FAKE_SIGNAL: "SIGKILL" },
      runExit: 1,
      verdict: { kind: "not-judged", reason: "the validator died on SIGKILL" },
      outputs: BLOCKED,
      comment: notJudged("the validator died on SIGKILL"),
    },
  ])("$reason", ({ env, runExit, verdict, outputs, comment }) => {
    const outcome = play({ env });
    expect(outcome).toEqual({
      runExit,
      verdict,
      outputs,
      summary: outcome.comment,
      comment,
    });
  });

  // A stale or planted verdict must never read as clean: the report trusts only a verdict the aligned validate
  // step wrote after a successful clear.
  test.each<{ reason: string; scenario: Scenario; text: string }>([
    {
      reason: "no verdict file (the validate step never ran)",
      scenario: { verdict: "absent" },
      text: "the aligned validator step wrote no verdict",
    },
    {
      reason: "a verdict file with a stray field",
      scenario: { verdict: "garbage" },
      text: "the aligned validator step wrote no verdict",
    },
    {
      reason: "a scratch root that could not be cleared",
      scenario: { verdict: { kind: "clean" }, clearOutcome: "failure" },
      text: "the scratch root could not be cleared (clear step outcome: failure)",
    },
  ])("the report alone fails closed on $reason", ({ scenario, text }) => {
    const outcome = play(scenario);
    expect([outcome.outputs, outcome.summary]).toEqual([BLOCKED, notJudged(text)]);
  });
});

describe("verdict.ts", () => {
  test("a timed-out validator is not judged, with the deadline in the reason", () => {
    const dir = temp.dir("verdict-classify-");
    const findingsFile = join(dir, "f.md");
    writeFileSync(findingsFile, "");
    expect(classify({ kind: "timed-out" }, 300_000, findingsFile)).toEqual({
      kind: "not-judged",
      reason: "the validator ran past its 300s deadline",
    });
  });

  // JSON.parse would accept a reordered or hand-edited verdict; only writeVerdict's own bytes are one.
  test("readVerdict accepts only writeVerdict's own bytes", () => {
    const dir = temp.dir("verdict-read-");
    const path = join(dir, "verdict.json");
    const verdict: Integrity = { kind: "findings", findings: "- x" };
    writeVerdict(path, verdict);
    expect(readVerdict(path)).toEqual(verdict);
    writeFileSync(path, '{"findings": "- x", "kind": "findings"}\n');
    expect(readVerdict(path).kind).toBe("not-judged");
    writeFileSync(path, '{"kind": "findings", "findings": ""}\n');
    expect(readVerdict(path).kind).toBe("not-judged");
  });
});
