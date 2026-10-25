#!/usr/bin/env bun
// The ONE reader of the verdict: the step summary, the sticky comment body, and the `report` output come from the
// same parsed value, written before the exit that fails the step on anything but clean.

import { appendFileSync, writeFileSync } from "node:fs";
import { env, requireEnv } from "../../shared/action_runtime.ts";
import { PLATFORM_NAME } from "../../shared/platform.ts";
import { type Integrity, readVerdict } from "./verdict.ts";

/** Unless the clear step succeeded, the validator never ran: any verdict on disk is stale or planted, so it is not
 *  read without a successful clear. */
function judgedIntegrity(clearOutcome: string): Integrity {
  if (clearOutcome === "success") {
    return readVerdict(requireEnv("VERDICT"));
  }

  return {
    kind: "not-judged",
    reason: `the scratch root could not be cleared (clear step outcome: ${clearOutcome || "none"})`,
  };
}

const verdict = judgedIntegrity(env("CLEAR_OUTCOME"));
const outputFile = requireEnv("GITHUB_OUTPUT");
const runUrl = requireEnv("RUN_URL");
const summaryFile = requireEnv("GITHUB_STEP_SUMMARY");
const commentFile = requireEnv("COMMENT_FILE");

const FAILS = "This FAILS the check.";

let integrity: string;
switch (verdict.kind) {
  case "clean":
    integrity = `Passed - this repository is what ${PLATFORM_NAME} writes at the commit it was synced with.`;
    break;
  case "findings":
    integrity = `${verdict.findings}\n\n${FAILS}`;
    break;
  case "not-judged":
    integrity = `Not judged: ${verdict.reason}. See the [run log](${runUrl}). ${FAILS}`;
    break;
}

const blocking = verdict.kind !== "clean";

const body = `### Managed files check\n\n${integrity}`;
// Appended by hand, the one summary writer not @actions/core's: this step runs on always(), after a failed
// install too (action.yml), so nothing here may need node_modules.
appendFileSync(summaryFile, `${body}\n`);

// The sticky steps in action.yml read both: the body from the file, and
// `report` to post it (findings) or to delete the comment an earlier run
// left (clean) - a clean repository has nothing worth a comment.
writeFileSync(commentFile, `${body}\n`);
appendFileSync(outputFile, `report=${blocking ? "findings" : "clean"}\n`);
console.log(`Managed files check: ${verdict.kind}${blocking ? ", in the step summary" : ""}.`);
process.exit(blocking ? 1 : 0);
