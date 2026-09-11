#!/usr/bin/env bun
// Runs the validator over the caller's checkout on the action's own bun and
// writes the one verdict: the child's exit and the report files it wrote
// are two witnesses to one event (verdict.ts), and the exit code follows
// the verdict for the step's colour only; the gate reads report.ts.
//
// Env: ACTION_BUN (the action's bun), ACTION_PATH, FILES_CONFIG (the build
// branch's files.yml, the module vocabulary), SCRATCH_DIR (the report
// files' directory), VERDICT_FILE. Runs from the caller's checkout.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { error, requireEnv, run } from "../../shared/action_runtime.ts";
import { classify, type Integrity, writeVerdict } from "./verdict.ts";

const VALIDATE_TIMEOUT_MS = 300_000;

const verdictFile = requireEnv("VERDICT_FILE");
const scratch = requireEnv("SCRATCH_DIR");
const root = resolve(".");

const conclude: (verdict: Integrity) => never = (verdict) => {
  writeVerdict(verdictFile, verdict);
  if (verdict.kind === "not-judged") error(verdict.reason);
  process.exit(verdict.kind === "clean" ? 0 : 1);
};

mkdirSync(scratch, { recursive: true });
const files = {
  findings: join(scratch, "findings.md"),
  advisories: join(scratch, "advisories.md"),
};
const exit = run(
  [
    requireEnv("ACTION_BUN"),
    join(requireEnv("ACTION_PATH"), "validator", "validate_managed_files.ts"),
    "--files",
    requireEnv("FILES_CONFIG"),
    root,
  ],
  {
    cwd: root,
    env: { FINDINGS_FILE: files.findings, ADVISORIES_FILE: files.advisories },
    timeoutMs: VALIDATE_TIMEOUT_MS,
  },
);
conclude(classify(exit, VALIDATE_TIMEOUT_MS, files));
