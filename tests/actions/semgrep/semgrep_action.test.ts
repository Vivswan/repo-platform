// The scan's exit status and its JSON copy are two witnesses: a clean JSON from a partial scan must not pass, and the
// severity filter is the verdict, so a filter that reads the wrong key counts 0 and passes every ERROR finding silently.
// The scan's argv is pinned where it leaves the program (what the semgrep binary receives), since every flag is semgrep's
// contract: a second --severity lets WARNING back in, --error makes the exit status mean "findings" instead of "did the
// scan complete", a narrower config or target skips findings with nothing red.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argvStub } from "../../shared/argv_stub";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const ACTION = join(import.meta.dir, "../../../actions/semgrep");

interface ScriptRun {
  exitCode: number;
  stdout: string;
  outputs: Record<string, string>;
}

function runScript(
  script: string,
  root: string,
  env: Record<string, string>,
  stub?: { bin: string },
): ScriptRun {
  const outputs = join(root, `${script}-outputs.txt`);
  writeFileSync(outputs, "");
  const run = boundedSpawnSync([process.execPath, join(ACTION, script)], {
    cwd: root,
    env: {
      PATH: stub === undefined ? (process.env.PATH ?? "") : `${stub.bin}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: outputs,
      ...env,
    },
  });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    outputs: Object.fromEntries(
      readFileSync(outputs, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    ),
  };
}

describe("actions/semgrep", () => {
  test("scan: the whole checkout against the registry's default ruleset at ERROR alone, and a fatal exit or a signal death records bash's status instead of failing the step", () => {
    const scan = (semgrepExit: number, extraLines: string[] = []) => {
      const root = temp.dir("semgrep-scan-");
      const semgrep = argvStub(root, "semgrep", extraLines);
      const run = runScript("scan.ts", root, { STUB_EXIT: String(semgrepExit) }, semgrep);
      return { calls: semgrep.calls(), exitCode: run.exitCode, outputs: run.outputs };
    };
    // 143 is bash's `$?` for a SIGTERM death (128 + 15), the number the old shell handed the judge.
    const [clean, fatal, killed] = [scan(0), scan(2), scan(0, ["kill -TERM $$"])];
    expect([clean, fatal, killed].map((run) => [run.exitCode, run.outputs])).toEqual([
      [0, { status: "0" }],
      [0, { status: "2" }],
      [0, { status: "143" }],
    ]);
    const argv = (run: ReturnType<typeof scan>) =>
      run.calls.map((call) =>
        call.map((arg) => arg.replace(/^(--\w+-output=).*\/(semgrep\.\w+)$/, "$1<temp>/$2")),
      );
    expect([argv(clean), argv(fatal)]).toEqual([
      [
        [
          "semgrep",
          "scan",
          "--config",
          "p/default",
          "--metrics=off",
          "--severity",
          "ERROR",
          "--exclude-rule=yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag",
          "--sarif-output=<temp>/semgrep.sarif",
          "--json-output=<temp>/semgrep.json",
          ".",
        ],
      ],
      argv(clean),
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
      // SARIF 2.1.0 makes `results` optional, and semgrep emits a run without one for a scan with no rule output.
      { tool: { driver: { name: "third, no results key" } } },
    ],
  });
  const drop = (sarif: object | null) => {
    const root = temp.dir("semgrep-drop-");
    const path = join(root, "semgrep.sarif");
    if (sarif !== null) writeFileSync(path, JSON.stringify(sarif));
    const run = runScript("drop_suppressed.ts", root, {});
    return { run, kept: existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null };
  };

  test("drop: the suppressed results leave every run and the rest survives whole; no SARIF passes and writes nothing", () => {
    // semgrep keeps a nosemgrep-marked finding in its SARIF as a suppressed result, and code scanning shows a suppressed
    // result as an OPEN alert: dropping nothing files bypassed findings as alerts, dropping too much loses real ones,
    // both green.
    const plain = { ruleId: "r" };
    const unsuppressed = { ruleId: "r", suppressions: [] };
    const { run, kept } = drop(sarifWith([suppressed("r"), plain, unsuppressed, suppressed("r")]));
    const expected = sarifWith([plain, unsuppressed]);
    expected.runs[1].results = [{ ruleId: "s" }];
    expect([run.exitCode, kept]).toEqual([0, expected]);
    const none = drop(null);
    expect([none.run.exitCode, none.kept]).toEqual([0, null]);
  });

  const judge = (json: string | null, scanStatus: string): { exitCode: number; stdout: string } => {
    const root = temp.dir("semgrep-judge-");
    if (json !== null) writeFileSync(join(root, "semgrep.json"), json);
    const run = runScript("judge.ts", root, { SCAN_STATUS: scanStatus });
    return { exitCode: run.exitCode, stdout: run.stdout.trim() };
  };
  const results = (severities: string[], errors: string[] = []) =>
    JSON.stringify({
      results: severities.map((severity) => ({ extra: { severity } })),
      errors: errors.map((level) => ({ level, type: "x", message: "m" })),
    });

  test("judge, status witness: a scan that did not complete fails naming its exit status, even when the JSON copy reads clean", () => {
    // An unrun step's output is empty (GitHub), refused as "none" instead of read as 0 findings.
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
      exitCode: 1,
      stdout: "",
    },
    {
      reason: "an unreadable results file fails closed",
      json: "{not json",
      exitCode: 1,
      stdout: "",
    },
  ])("judge, JSON witness: $reason", ({ json, exitCode, stdout }) => {
    expect(judge(json, "0")).toEqual({ exitCode, stdout });
  });
});
