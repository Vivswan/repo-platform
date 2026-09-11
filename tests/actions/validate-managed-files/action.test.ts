// Behaviour tests for the validate-managed-files action's scripts: the
// REAL run.ts and report.ts run here, run.ts over a stand-in validator so
// every classification of the child (clean, findings, crashed, timed out,
// signal-killed, a report pair that disagrees with the exit) reaches
// report.ts as the one verdict. The report step never fails, so a
// blocking verdict is readable in the PR conversation before the caller
// fails the job. Every scenario is judged WHOLE (summary, comment body,
// outputs file, verdict file).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classify,
  type Integrity,
  readVerdict,
  writeVerdict,
} from "../../../actions/validate-managed-files/src/verdict";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const ACTION = join(import.meta.dir, "../../../actions/validate-managed-files");
const RUN_URL = "https://example.invalid/run/1";

// Stands in for the validator: writes the report pair (unless told to
// skip), then exits or dies as told, so run.ts's classification is what
// the test sees.
const fakeValidator = `import { writeFileSync } from "node:fs";
if (!process.env.FAKE_SKIP_REPORT) {
  writeFileSync(process.env.FINDINGS_FILE, process.env.FAKE_FINDINGS ?? "");
  writeFileSync(process.env.ADVISORIES_FILE, process.env.FAKE_ADVISORIES ?? "");
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
  /** Skip run.ts: the verdict file stays as `verdict` writes it (or absent). */
  verdict?: Integrity | "absent" | "garbage";
  clearOutcome?: string;
}

interface Outcome {
  runExit: number | null;
  verdict: Integrity | null;
  outputs: string;
  summary: string;
  comment: string;
  stdout: string;
}

function play(scenario: Scenario): Outcome {
  const root = temp.dir("validate-managed-action-");
  const actionPath = join(root, "action");
  mkdirSync(join(actionPath, "validator"), { recursive: true });
  // The action's own scripts, the validator swapped for the stand-in.
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
        SCRATCH_DIR: scratch,
        VERDICT_FILE: verdictFile,
        ...scenario.env,
      },
    });
    runExit = result.exitCode;
  } else if (scenario.verdict === "garbage") {
    writeFileSync(verdictFile, '{"kind": "clean", "advisories": "", "extra": 1}\n');
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
    stdout: report.stdout,
  };
}

describe("the validator's classification reaches the report as one verdict", () => {
  test("a clean run passes, deletes any stale comment, and posts nothing", () => {
    const outcome = play({});
    expect(outcome.runExit).toBe(0);
    expect(outcome.verdict).toEqual({ kind: "clean", advisories: "" });
    expect(outcome.outputs).toBe("integrity=success\nreport=clean\n");
    expect(outcome.summary).toBe(
      "### Managed files check\n\nPassed - this repository matches the state its last sync recorded.\n",
    );
    expect(outcome.comment).toBe(outcome.summary);
  });

  test("a clean run with advisories is green but worth a comment", () => {
    const advisories = "#### Advisories (1)\n\n- package.json: packageManager is redundant";
    const outcome = play({ env: { FAKE_ADVISORIES: `${advisories}\n` } });
    expect(outcome.runExit).toBe(0);
    expect(outcome.verdict).toEqual({ kind: "clean", advisories });
    expect(outcome.outputs).toBe("integrity=success\nreport=findings\n");
    expect(outcome.comment).toContain(advisories);
  });

  test("findings block, carry the remedy, and are posted", () => {
    const findings = "#### Errors (1)\n\n- ci.yml: content does not match";
    const outcome = play({ env: { FAKE_EXIT: "1", FAKE_FINDINGS: `${findings}\n` } });
    expect(outcome.runExit).toBe(1);
    expect(outcome.verdict).toEqual({ kind: "findings", findings, advisories: "" });
    expect(outcome.outputs).toBe("integrity=failure\nreport=findings\n");
    expect(outcome.comment).toContain(findings);
    expect(outcome.comment).toContain("Managed content changed outside a sync.");
    expect(outcome.comment).toContain("This FAILS the check.");
  });

  test.each<{ reason: string; env: Record<string, string>; text: string }>([
    {
      reason: "a validator that exited 0 yet reported findings",
      env: { FAKE_FINDINGS: "- x\n" },
      text: "the validator exited 0 yet reported findings",
    },
    {
      reason: "a validator that exited nonzero without a finding",
      env: { FAKE_EXIT: "1" },
      text: "the validator exited 1 without reporting a finding",
    },
    {
      reason: "a validator that crashed before reporting",
      env: { FAKE_EXIT: "2", FAKE_SKIP_REPORT: "1" },
      text: "the validator exited 2 before reporting",
    },
    {
      reason: "a validator killed by a signal",
      env: { FAKE_SIGNAL: "SIGKILL" },
      text: "the validator died on SIGKILL",
    },
  ])("$reason is not-judged and blocks", ({ env, text }) => {
    const outcome = play({ env });
    expect(outcome.runExit).toBe(1);
    expect(outcome.verdict).toEqual({ kind: "not-judged", reason: text });
    expect(outcome.outputs).toBe("integrity=failure\nreport=findings\n");
    expect(outcome.comment).toContain(`Not judged: ${text}. See the [run log](${RUN_URL}).`);
  });

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
      scenario: { verdict: { kind: "clean", advisories: "" }, clearOutcome: "failure" },
      text: "the scratch root could not be cleared (clear step outcome: failure)",
    },
  ])("the report alone fails closed on $reason", ({ scenario, text }) => {
    const outcome = play(scenario);
    expect(outcome.outputs).toBe("integrity=failure\nreport=findings\n");
    expect(outcome.summary).toContain(`Not judged: ${text}.`);
  });
});

describe("verdict.ts", () => {
  test("classify reads the exit and the report pair as two witnesses", () => {
    const dir = temp.dir("verdict-classify-");
    const files = { findings: join(dir, "f.md"), advisories: join(dir, "a.md") };
    writeFileSync(files.findings, "");
    writeFileSync(files.advisories, "note\n");
    expect(classify({ kind: "exited", code: 0 }, 1000, files)).toEqual({
      kind: "clean",
      advisories: "note",
    });
    expect(classify({ kind: "timed-out" }, 300_000, files)).toEqual({
      kind: "not-judged",
      reason: "the validator ran past its 300s deadline",
    });
  });

  test("readVerdict accepts only writeVerdict's own bytes", () => {
    const dir = temp.dir("verdict-read-");
    const path = join(dir, "verdict.json");
    const verdict: Integrity = { kind: "findings", findings: "- x", advisories: "" };
    writeVerdict(path, verdict);
    expect(readVerdict(path)).toEqual(verdict);
    writeFileSync(path, '{"findings": "- x", "kind": "findings", "advisories": ""}\n');
    expect(readVerdict(path).kind).toBe("not-judged");
    writeFileSync(path, '{"kind": "findings", "findings": "", "advisories": ""}\n');
    expect(readVerdict(path).kind).toBe("not-judged");
  });
});
