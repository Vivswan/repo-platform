#!/usr/bin/env bun
// The integrity leg's JUDGE: installs and runs the validator the fetch step
// laid out, on the bun the setup-bun step between them installed from that
// tree's own pin (ALIGNED_BUN; this script itself keeps running on the
// action's bun, so an old pin can never break the judging), and turns how the run ended into the one verdict
// report.ts renders (verdict.ts). The exit code follows the verdict - 0
// only for `clean` - so the step's outcome, the caller's `integrity`
// output, can never disagree with what the comment says.
//
// Env: ALIGNED_DIR (the fetch step's layout), VERDICT_FILE, ALIGNED_BUN
// (the fetched tree's bun). Runs from the caller's checkout.

import { join, resolve } from "node:path";
import { reportFilesOf, VALIDATOR_SCRIPT, validatorOf } from "./aligned_tree.ts";
import { capture, error, failureDetail, requireEnv, run } from "./runtime.ts";
import { classify, type Integrity, writeVerdict } from "./verdict.ts";

const INSTALL_TIMEOUT_MS = 180_000;
const VALIDATE_TIMEOUT_MS = 300_000;

const alignedDir = requireEnv("ALIGNED_DIR");
const verdictFile = requireEnv("VERDICT_FILE");
const alignedBun = requireEnv("ALIGNED_BUN");
const root = resolve(".");
const validator = validatorOf(alignedDir);

const conclude: (verdict: Integrity) => never = (verdict) => {
  writeVerdict(verdictFile, verdict);
  if (verdict.kind === "not-judged") error(verdict.reason);
  process.exit(verdict.kind === "clean" ? 0 : 1);
};

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
