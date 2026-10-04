// The two files the scan writes under RUNNER_TEMP, named once: scan.ts writes them, drop_suppressed.ts and judge.ts
// read them, and action.yml's upload step names the SARIF by the same stem.

import { join } from "node:path";

export const SARIF_NAME = "semgrep.sarif";
export const JSON_NAME = "semgrep.json";

export function sarifPath(runnerTemp: string): string {
  return join(runnerTemp, SARIF_NAME);
}

export function jsonPath(runnerTemp: string): string {
  return join(runnerTemp, JSON_NAME);
}
