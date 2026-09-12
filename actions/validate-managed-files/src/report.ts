#!/usr/bin/env bun
// The ONE reader of the verdict: the `integrity` output, the step summary, and the sticky comment body come from the
// same parsed value. Never fails the job; the caller re-raises `integrity` last.

import { appendFileSync, writeFileSync } from "node:fs";
import { env, requireEnv } from "../../shared/action_runtime.ts";
import { type Integrity, readVerdict } from "./verdict.ts";

// Unless the clear step succeeded, the validator never ran: any verdict on
// disk is stale or planted, so it is not read without a successful clear.
const clearOutcome = env("CLEAR_OUTCOME");
const verdict: Integrity =
  clearOutcome === "success"
    ? readVerdict(requireEnv("VERDICT"))
    : {
        kind: "not-judged",
        reason: `the scratch root could not be cleared (clear step outcome: ${clearOutcome || "none"})`,
      };
// Exported before anything else can go wrong: this line IS the gate.
const outputFile = requireEnv("GITHUB_OUTPUT");
appendFileSync(outputFile, `integrity=${verdict.kind === "clean" ? "success" : "failure"}\n`);
const runUrl = requireEnv("RUN_URL");
const summaryFile = requireEnv("GITHUB_STEP_SUMMARY");
const commentFile = requireEnv("COMMENT_FILE");

/** The kind-change hold is write_link.ts's rule. */
const REMEDY =
  "Managed content changed outside a sync. Restore the file from git history, or re-run the sync: it rewrites managed files whole but holds a path whose kind changed (a file in a link's place) for this repository to restore. This FAILS the check.";

let integrity: string;
switch (verdict.kind) {
  case "clean":
    integrity = "Passed - this repository matches the state its last sync recorded.";
    break;
  case "findings":
    integrity = `${verdict.findings}\n${REMEDY}`;
    break;
  case "not-judged":
    integrity = `Not judged: ${verdict.reason}. See the [run log](${runUrl}). This FAILS the check.`;
    break;
}
const blocking = verdict.kind !== "clean";

// Advisories never gate - they are the validator's own non-failing stream,
// and folding them into the verdict would have a clean repository reading
// as blocked.
const advisories = verdict.kind === "not-judged" ? "" : verdict.advisories;
const advice = advisories === "" ? "" : `\n\n${advisories}`;

const body = `### Managed files check\n\n${integrity}${advice}`;
appendFileSync(summaryFile, `${body}\n`);

// The sticky steps in action.yml read both: the body from the file, and
// `report` to post it (findings) or to delete the comment an earlier run
// left (clean) - a clean repository has nothing worth a comment.
writeFileSync(commentFile, `${body}\n`);
const worthSaying = blocking || advice !== "";
appendFileSync(outputFile, `report=${worthSaying ? "findings" : "clean"}\n`);
