// The scan's exit status and its JSON copy are two witnesses: a clean JSON from a partial scan must not pass, and the
// severity filter in the judge's jq is the verdict, so a typo there counts 0 and passes every ERROR finding silently.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/semgrep/action.yml");

describe("actions/semgrep", () => {
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

  test("scan: a fatal exit does not fail the step and records the status, so the judge reads what happened", () => {
    // Under `-e` a fatal scan would end the step and the judge, whose `!cancelled()` still runs it, would read an empty
    // status. A second --severity lets WARNING back in; --error makes the exit status mean "findings" instead of "did
    // the scan complete".
    const command = String(stepNamed(action, "Scan").run);
    expect(command.match(/--severity[= ](\S+)/g)).toEqual(["--severity ERROR"]);
    expect(command).not.toContain("--error");
    // The registry's whole default ruleset over the whole checkout, on one pinned release: a narrower config or
    // target skips files with nothing red, and an unpinned install moves the fleet to each new release silently.
    expect([
      command.match(/--config[= ](\S+)/g),
      / \. \\\n\s+&& status=0/.test(command),
      String(stepNamed(action, "Install semgrep").run),
    ]).toEqual([
      ["--config p/default"],
      true,
      expect.stringMatching(/^python3 -m pip install --quiet semgrep==\d+\.\d+\.\d+$/),
    ]);
    expect(
      [0, 2].map((exit) => {
        const run = scan(exit);
        return [run.exitCode, run.outputs];
      }),
    ).toEqual([
      [0, { status: "0" }],
      [0, { status: "2" }],
    ]);
  });

  // A result carrying a suppression is semgrep's shape for a nosemgrep-marked finding.
  const suppressed = (ruleId: string) => ({ ruleId, suppressions: [{ kind: "inSource" }] });
  const sarifWith = (firstRunResults: object[]) => ({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "Semgrep OSS", semanticVersion: "1.0.0", rules: [{ id: "r" }] } },
        invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }],
        results: firstRunResults,
      },
      {
        tool: { driver: { name: "second" } },
        results: [{ ruleId: "s" }, suppressed("s")],
      },
    ],
  });
  const drop = (sarif: object | null) => {
    const root = temp.dir("semgrep-drop-");
    const path = join(root, "semgrep.sarif");
    if (sarif !== null) writeFileSync(path, JSON.stringify(sarif));
    const run = runBashStep(stepNamed(action, "Drop the marked findings from the SARIF"), {
      cwd: root,
      root,
      env: { RUNNER_TEMP: root },
    });
    return { run, kept: existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null };
  };

  test("drop: the suppressed results leave every run and the rest survives whole; no SARIF passes and writes nothing; one upload category", () => {
    // semgrep keeps a nosemgrep-marked finding in its SARIF as a suppressed result, and code scanning shows a suppressed
    // result as an OPEN alert: dropping nothing files bypassed findings as alerts, dropping too much loses real ones,
    // both green. Code scanning marks alerts fixed per category and branch, so a renamed category leaves every old
    // alert open forever.
    const plain = { ruleId: "r" };
    const unsuppressed = { ruleId: "r", suppressions: [] };
    const { run, kept } = drop(sarifWith([suppressed("r"), plain, unsuppressed, suppressed("r")]));
    const expected = sarifWith([plain, unsuppressed]);
    expected.runs[1].results = [{ ruleId: "s" }];
    expect([run.exitCode, kept]).toEqual([0, expected]);
    const none = drop(null);
    expect([none.run.exitCode, none.kept]).toEqual([0, null]);
    const upload = stepNamed(action, "Upload the findings to code scanning");
    expect((upload.with as Record<string, string>).category).toBe("semgrep");
  });

  const judge = (json: string | null, scanStatus: string): { exitCode: number; stdout: string } => {
    const root = temp.dir("semgrep-judge-");
    if (json !== null) writeFileSync(join(root, "semgrep.json"), json);
    const run = runBashStep(stepNamed(action, "Fail on an ERROR finding"), {
      fills: { "${{ steps.scan.outputs.status }}": scanStatus },
      cwd: root,
      root,
      env: { RUNNER_TEMP: root },
    });
    return { exitCode: run.exitCode, stdout: run.stdout.trim() };
  };
  const results = (severities: string[], errors: string[] = []) =>
    JSON.stringify({
      results: severities.map((severity) => ({ extra: { severity } })),
      errors: errors.map((level) => ({ level, type: "x", message: "m" })),
    });

  test("judge, status witness: a scan that did not complete fails naming its exit status, even when the JSON copy reads clean", () => {
    // An unrun step's output is empty (GitHub); `${SCAN_STATUS:-none}` is the spelling that refuses it instead of
    // reading it as 0 findings.
    expect([judge(results([]), "2"), judge(results([]), "")]).toEqual([
      {
        exitCode: 1,
        stdout:
          "::error::semgrep: the scan did not complete (exit status 2), so there is no verdict; see the scan log above",
      },
      {
        exitCode: 1,
        stdout:
          "::error::semgrep: the scan did not complete (exit status none), so there is no verdict; see the scan log above",
      },
    ]);
  });

  test.each<{ reason: string; json: string | null; exitCode: number; stdout: string }>([
    { reason: "no findings passes", json: results([]), exitCode: 0, stdout: "" },
    {
      reason: "only ERROR findings count, so a WARNING or INFO one passes",
      json: results(["WARNING", "INFO"]),
      exitCode: 0,
      stdout: "",
    },
    {
      reason: "ERROR findings fail, counted in the annotation",
      json: results(["WARNING", "ERROR", "ERROR"]),
      exitCode: 1,
      stdout:
        "::error::semgrep: 2 ERROR-severity finding(s), 0 fatal analysis error(s); see the scan log above",
    },
    {
      reason: "a fatal analysis error fails with no findings (a broken scan is not a clean one)",
      json: results([], ["error"]),
      exitCode: 1,
      stdout:
        "::error::semgrep: 0 ERROR-severity finding(s), 1 fatal analysis error(s); see the scan log above",
    },
    {
      reason:
        "warn-level analysis errors (partial parses, timeouts) pass with one warning annotation",
      json: results([], ["warn", "warn"]),
      exitCode: 0,
      stdout:
        "::warning::semgrep: 2 non-fatal analysis error(s) (partial parses, timeouts); see the scan log above",
    },
    {
      reason: "a missing results file fails closed, never as 0 findings",
      json: null,
      exitCode: 2,
      stdout: "",
    },
    {
      reason: "an unreadable results file fails closed",
      json: "{not json",
      exitCode: 5,
      stdout: "",
    },
  ])("judge, JSON witness: $reason", ({ json, exitCode, stdout }) => {
    expect(judge(json, "0")).toEqual({ exitCode, stdout });
  });
});
