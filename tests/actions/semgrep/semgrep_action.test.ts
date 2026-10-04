// Three external facts: semgrep keeps a nosemgrep-marked finding in its SARIF under `suppressions` (its JSON copy
// drops it), code scanning reads no `suppressions` property, and SARIF 2.1.0 makes a run's `results` optional.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/semgrep/drop_suppressed.ts");

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
    { tool: { driver: { name: "third, no results key" } } },
  ],
});
const drop = (sarif: object | null) => {
  const root = temp.dir("semgrep-drop-");
  const path = join(root, "semgrep.sarif");
  if (sarif !== null) writeFileSync(path, JSON.stringify(sarif));
  const run = boundedSpawnSync([process.execPath, SCRIPT], {
    env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: root },
  });
  return {
    exitCode: run.exitCode,
    kept: existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null,
  };
};

describe("drop_suppressed.ts", () => {
  test("the suppressed results leave every run and the rest survives whole; no SARIF passes and writes nothing", () => {
    const plain = { ruleId: "r" };
    const unsuppressed = { ruleId: "r", suppressions: [] };
    const expected = sarifWith([plain, unsuppressed]);
    expected.runs[1].results = [{ ruleId: "s" }];
    expect([
      drop(sarifWith([suppressed("r"), plain, unsuppressed, suppressed("r")])),
      drop(null),
    ]).toEqual([
      { exitCode: 0, kept: expected },
      { exitCode: 0, kept: null },
    ]);
  });
});
