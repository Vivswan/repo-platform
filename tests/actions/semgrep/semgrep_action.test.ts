// The semgrep action's contract: a pinned install, one scan writing both a
// SARIF copy (uploaded whole) and a JSON copy, and a verdict step that fails
// on ERROR severity alone - executed here against fixture scan results.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/semgrep/action.yml");

describe("actions/semgrep", () => {
  test("install, scan, upload, judge: pinned, registry default ruleset, both outputs, no --error", () => {
    expect(action.runs.using).toBe("composite");
    expect(action.inputs).toBeUndefined();
    const [install, scan, upload, judge] = action.runs.steps;
    expect(String(install.run)).toMatch(/^python3 -m pip install --quiet semgrep==\d+\.\d+\.\d+$/);
    const command = String(scan.run);
    expect(command.startsWith("semgrep scan --config p/default ")).toBe(true);
    expect(command).toContain('--sarif-output="$RUNNER_TEMP/semgrep.sarif"');
    expect(command).toContain('--json-output="$RUNNER_TEMP/semgrep.json"');
    // --error would fail the scan on WARNING findings too; the judge below
    // is the verdict, and --severity would hide them from code scanning.
    expect(command).not.toContain("--error");
    expect(command).not.toContain("--severity");
    expect(upload.uses).toMatch(/^github\/codeql-action\/upload-sarif@/);
    expect(upload.with).toEqual({
      sarif_file: "${{ runner.temp }}/semgrep.sarif",
      category: "semgrep",
    });
    expect(judge.name).toBe("Fail on an ERROR finding");
  });

  const judge = (results: { severity: string }[], errors: { level: string }[] = []) => {
    const root = temp.dir("semgrep-judge-");
    writeFileSync(
      join(root, "semgrep.json"),
      JSON.stringify({
        results: results.map((r) => ({ extra: { severity: r.severity } })),
        errors: errors.map((e) => ({ level: e.level, type: "x", message: "m" })),
      }),
    );
    return runBashStep(stepNamed(action, "Fail on an ERROR finding"), {
      cwd: root,
      root,
      env: { RUNNER_TEMP: root },
    });
  };

  test("judge: no findings passes", () => {
    const run = judge([]);
    expect([run.exitCode, run.stdout]).toEqual([0, ""]);
  });

  test("judge: WARNING and INFO findings pass (they reach code scanning, not the gate)", () => {
    expect(judge([{ severity: "WARNING" }, { severity: "INFO" }]).exitCode).toBe(0);
  });

  test("judge: one ERROR finding fails, counted in the error annotation", () => {
    const run = judge([{ severity: "WARNING" }, { severity: "ERROR" }, { severity: "ERROR" }]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("::error::semgrep: 2 ERROR-severity finding(s), 0 fatal");
  });

  test("judge: a fatal analysis error fails even with no findings (a broken scan is not a clean one)", () => {
    const run = judge([], [{ level: "error" }]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("0 ERROR-severity finding(s), 1 fatal analysis error(s)");
  });

  test("judge: warn-level analysis errors (partial parses, timeouts) pass with one warning annotation", () => {
    const run = judge([], [{ level: "warn" }, { level: "warn" }]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe(
      "::warning::semgrep: 2 non-fatal analysis error(s) (partial parses, timeouts); see the scan log above",
    );
  });

  test("judge: a missing or unreadable results file fails closed", () => {
    const root = temp.dir("semgrep-missing-");
    const run = runBashStep(stepNamed(action, "Fail on an ERROR finding"), {
      cwd: root,
      root,
      env: { RUNNER_TEMP: root },
    });
    expect(run.exitCode).not.toBe(0);
    writeFileSync(join(root, "semgrep.json"), "{not json");
    expect(
      runBashStep(stepNamed(action, "Fail on an ERROR finding"), {
        cwd: root,
        root,
        env: { RUNNER_TEMP: root },
      }).exitCode,
    ).not.toBe(0);
  });
});
