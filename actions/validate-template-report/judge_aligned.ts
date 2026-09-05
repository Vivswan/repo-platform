#!/usr/bin/env bun
// The integrity leg's JUDGE: runs the fetched validator on the fetched
// tree's own bun (ALIGNED_BUN) and writes the one verdict. The exit code
// follows the verdict for the step's colour only; the gate reads report.ts.
//
// Env: ALIGNED_DIR, VERDICT_FILE, ALIGNED_BUN (the fetched tree's bun, or
// empty when none matching its pin is on PATH). Runs from the caller's
// checkout.

import { join, resolve } from "node:path";
import { reportFilesOf, VALIDATOR_SCRIPT, validatorOf } from "./aligned_tree.ts";
import { capture, env, error, failureDetail, requireEnv, run } from "./runtime.ts";
import { classify, type Integrity, writeVerdict } from "./verdict.ts";

const INSTALL_TIMEOUT_MS = 180_000;
const VALIDATE_TIMEOUT_MS = 300_000;

const alignedDir = requireEnv("ALIGNED_DIR");
const verdictFile = requireEnv("VERDICT_FILE");
const alignedBun = env("ALIGNED_BUN");
const root = resolve(".");
const validator = validatorOf(alignedDir);

const conclude: (verdict: Integrity) => never = (verdict) => {
  writeVerdict(verdictFile, verdict);
  if (verdict.kind === "not-judged") error(verdict.reason);
  process.exit(verdict.kind === "clean" ? 0 : 1);
};

// Without the tree's bun, `bun` on PATH is the action's; running the tree
// on it is what the setup step exists to prevent.
if (alignedBun === "") {
  conclude({
    kind: "not-judged",
    reason: "no bun matching the fetched tree's .bun-version is available",
  });
}

const installed = capture([alignedBun, "install", "--frozen-lockfile", "--production"], {
  cwd: validator,
  timeoutMs: INSTALL_TIMEOUT_MS,
});
if (installed.exitCode !== 0) {
  console.log(installed.stdout + installed.stderr);
  conclude({
    kind: "not-judged",
    reason: `could not install the validator's dependencies: ${failureDetail(installed)}`,
  });
}

console.log(`Judging the tree with the validator at ${validator} on ${alignedBun}`);
const files = reportFilesOf(alignedDir);
const exit = run([alignedBun, join(validator, VALIDATOR_SCRIPT), root], {
  cwd: root,
  env: { FINDINGS_FILE: files.findings, ADVISORIES_FILE: files.advisories },
  timeoutMs: VALIDATE_TIMEOUT_MS,
});
conclude(classify(exit, VALIDATE_TIMEOUT_MS, files));
