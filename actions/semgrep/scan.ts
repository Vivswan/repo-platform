#!/usr/bin/env bun
// No --error: the exit status means "did the scan complete"; judge.ts is the verdict. The status is a step output,
// not the step's result, so a fatal scan still reaches the judge through its `!cancelled()`.

import { appendFileSync } from "node:fs";
import { constants } from "node:os";
import { type ChildExit, requireEnv, run } from "../shared/action_runtime.ts";
import { jsonPath, sarifPath } from "./reports.ts";

/** The calling job's timeout-minutes is the scan's deadline (15 in fleet-ci.yml); this bound only names a hang the
 *  runner has not already ended, so it sits far above any job's. */
const SCAN_TIMEOUT_MS = 60 * 60_000;

/** The registry's whole default ruleset at ERROR severity alone, over the whole checkout
 *  (docs/modules/security-scans.md); mutable-action-tag is excluded because zizmor's unpinned-uses owns that finding class. */
export function scanArgv(runnerTemp: string): string[] {
  return [
    "semgrep",
    "scan",
    "--config",
    "p/default",
    "--metrics=off",
    "--severity",
    "ERROR",
    "--exclude-rule=yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag",
    `--sarif-output=${sarifPath(runnerTemp)}`,
    `--json-output=${jsonPath(runnerTemp)}`,
    ".",
  ];
}

/** What the judge reads: bash's `$?` for the scan (the exit code, or 128 plus the signal that killed it). */
export function scanStatus(exit: ChildExit): string {
  switch (exit.kind) {
    case "exited":
      return String(exit.code);
    case "signaled": {
      const number = (constants.signals as Record<string, number | undefined>)[exit.signal];
      return number === undefined ? exit.signal : String(128 + number);
    }
    case "timed-out":
      return "timed-out";
  }
}

if (import.meta.main) {
  const exit = run(scanArgv(requireEnv("RUNNER_TEMP")), { timeoutMs: SCAN_TIMEOUT_MS });
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `status=${scanStatus(exit)}\n`);
}
