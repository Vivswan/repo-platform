// The semgrep action's contract: a pinned install, one scan writing both a
// SARIF copy (uploaded without its suppressed results) and a JSON copy with
// its exit status as a step output, and a verdict step that runs whatever
// the scan did and fails on a fatal scan or an ERROR finding - executed here
// against fixture results.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/semgrep/action.yml");

describe("actions/semgrep", () => {
  test("install, scan, upload, judge: pinned, registry default ruleset, both outputs, no --error", () => {
    expect(action.runs.using).toBe("composite");
    expect(action.inputs).toBeUndefined();
    const [install, scan, drop, upload, judge] = action.runs.steps;
    expect(String(install.run)).toMatch(/^python3 -m pip install --quiet semgrep==\d+\.\d+\.\d+$/);
    const command = String(scan.run);
    expect(scan.id).toBe("scan");
    expect(command.startsWith("semgrep scan --config p/default ")).toBe(true);
    expect(command).toContain('--sarif-output="$RUNNER_TEMP/semgrep.sarif"');
    expect(command).toContain('--json-output="$RUNNER_TEMP/semgrep.json"');
    // --error would fail the scan on WARNING findings too; the judge below
    // is the verdict, and --severity would hide them from code scanning.
    expect(command).not.toContain("--error");
    expect(command).not.toContain("--severity");
    // Registry ids carry their path; the id semgrep matches is the one code
    // scanning shows. zizmor's unpinned-uses owns action pinning; the fleet's
    // old rendered ci.yml and release.yml carry no nosemgrep marker on their
    // `secrets: inherit` lines until the writer cutover replaces them.
    expect(command.match(/--exclude-rule=(\S+)/g)).toEqual([
      "--exclude-rule=yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag",
      "--exclude-rule=yaml.github-actions.security.secrets-inherit.secrets-inherit",
    ]);
    expect(upload.uses).toMatch(/^github\/codeql-action\/upload-sarif@[0-9a-f]{40}$/);
    expect(upload.with).toEqual({
      sarif_file: "${{ runner.temp }}/semgrep.sarif",
      category: "semgrep",
    });
    expect(drop.name).toBe("Drop the marked findings from the SARIF");
    expect(drop.if).toBe("${{ !cancelled() }}");
    expect(judge.name).toBe("Fail on an ERROR finding");
  });

  test("a fatal scan reaches the verdict: the scan's status is a step output, and the upload and judge run unless cancelled", () => {
    const [, scan, , upload, judge] = action.runs.steps;
    expect(String(scan.run)).toContain(" . \\\n  && status=0 || status=$?\n");
    expect(String(scan.run)).toContain('echo "status=$status" >>"$GITHUB_OUTPUT"');
    expect(upload.if).toBe("${{ !cancelled() }}");
    expect(judge.if).toBe("${{ !cancelled() }}");
    expect(judge.env).toEqual({ SCAN_STATUS: "${{ steps.scan.outputs.status }}" });
  });

  // The scan step against a stand-in semgrep on PATH that exits as told.
  const scan = (semgrepExit: number) => {
    const root = temp.dir("semgrep-scan-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "semgrep"), `#!/bin/bash\nexit ${semgrepExit}\n`);
    chmodSync(join(bin, "semgrep"), 0o755);
    return runBashStep(stepNamed(action, "Scan"), {
      cwd: root,
      root,
      env: { RUNNER_TEMP: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
  };

  test("scan: a clean exit records status 0", () => {
    const run = scan(0);
    expect([run.exitCode, run.outputs]).toEqual([0, { status: "0" }]);
  });

  test("scan: a fatal exit does not fail the step (the judge must run) and records the status", () => {
    const run = scan(2);
    expect([run.exitCode, run.outputs]).toEqual([0, { status: "2" }]);
  });

  // The drop step against a SARIF copy: a result carrying a suppression
  // (semgrep's shape for a nosemgrep-marked finding) leaves; the rest stay.
  const drop = (results: object[] | null) => {
    const root = temp.dir("semgrep-drop-");
    if (results !== null) {
      writeFileSync(join(root, "semgrep.sarif"), JSON.stringify({ runs: [{ results }] }));
    }
    const run = runBashStep(stepNamed(action, "Drop the marked findings from the SARIF"), {
      cwd: root,
      root,
      env: { RUNNER_TEMP: root },
    });
    const sarif = join(root, "semgrep.sarif");
    return {
      run,
      kept: existsSync(sarif) ? JSON.parse(readFileSync(sarif, "utf-8")).runs[0].results : null,
    };
  };

  test("drop: a suppressed result leaves the SARIF, an unsuppressed or empty-suppressions one stays", () => {
    const marked = { ruleId: "r", suppressions: [{ kind: "inSource" }] };
    const plain = { ruleId: "r" };
    const unsuppressed = { ruleId: "r", suppressions: [] };
    const { run, kept } = drop([marked, plain, unsuppressed, marked]);
    expect([run.exitCode, kept]).toEqual([0, [plain, unsuppressed]]);
  });

  test("drop: no SARIF (a scan that never wrote one) passes and writes nothing", () => {
    const { run, kept } = drop(null);
    expect([run.exitCode, kept]).toEqual([0, null]);
  });

  const judge = (
    results: { severity: string }[],
    errors: { level: string }[] = [],
    scanStatus = "0",
  ) => {
    const root = temp.dir("semgrep-judge-");
    writeFileSync(
      join(root, "semgrep.json"),
      JSON.stringify({
        results: results.map((r) => ({ extra: { severity: r.severity } })),
        errors: errors.map((e) => ({ level: e.level, type: "x", message: "m" })),
      }),
    );
    return runBashStep(stepNamed(action, "Fail on an ERROR finding"), {
      fills: { "${{ steps.scan.outputs.status }}": scanStatus },
      cwd: root,
      root,
      env: { RUNNER_TEMP: root },
    });
  };

  test("judge: a fatal scan fails naming its exit status, even when the JSON copy reads clean", () => {
    const run = judge([], [], "2");
    expect(run.exitCode).toBe(1);
    expect(run.stdout.trim()).toBe(
      "::error::semgrep: the scan did not complete (exit status 2), so there is no verdict; see the scan log above",
    );
  });

  test("judge: a scan that never ran (empty status) fails the same way, never as no findings", () => {
    const run = judge([], [], "");
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("(exit status none)");
  });

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
    const options = {
      fills: { "${{ steps.scan.outputs.status }}": "0" },
      cwd: root,
      root,
      env: { RUNNER_TEMP: root },
    };
    expect(runBashStep(stepNamed(action, "Fail on an ERROR finding"), options).exitCode).not.toBe(
      0,
    );
    writeFileSync(join(root, "semgrep.json"), "{not json");
    expect(runBashStep(stepNamed(action, "Fail on an ERROR finding"), options).exitCode).not.toBe(
      0,
    );
  });
});
