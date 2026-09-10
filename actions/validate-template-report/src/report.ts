#!/usr/bin/env bun
// The validate-template job's reporting and the ONE reader of the verdict:
// the `integrity` output, the step summary, and the comment body that the
// sticky steps in action.yml post come from the same parsed value. Never
// fails the job; the caller re-raises `integrity` last.
//
// Env: GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, COMMENT_FILE, VERDICT,
// CLEAR_OUTCOME, LATEST_FINDINGS, LATEST_ADVISORIES, COMPARE_STATUS,
// AHEAD_BY, RUN_URL.

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { env, requireEnv } from "../../shared/action_runtime.ts";
import { type Integrity, readVerdict } from "./verdict.ts";

// Unless the clear step succeeded, neither fetch nor the latest leg ran:
// any verdict or latest report on disk is stale or planted, so neither is
// read without a successful clear.
const clearOutcome = env("CLEAR_OUTCOME");
const cleared = clearOutcome === "success";
const verdict: Integrity = cleared
  ? readVerdict(requireEnv("VERDICT"))
  : {
      kind: "not-judged",
      reason: `the scratch root could not be cleared (clear step outcome: ${clearOutcome || "none"})`,
    };
// Exported before anything else can go wrong: this line IS the gate.
const outputFile = requireEnv("GITHUB_OUTPUT");
appendFileSync(outputFile, `integrity=${verdict.kind === "clean" ? "success" : "failure"}\n`);
const latestFindingsFile = requireEnv("LATEST_FINDINGS");
const latestAdvisoriesFile = requireEnv("LATEST_ADVISORIES");
const compareStatus = env("COMPARE_STATUS");
const aheadBy = env("AHEAD_BY");
const runUrl = requireEnv("RUN_URL");
const summaryFile = requireEnv("GITHUB_STEP_SUMMARY");
const commentFile = requireEnv("COMMENT_FILE");

/** A file's text with trailing newlines stripped, or null when there is
 *  no regular file at the path. */
const readReport = (path: string): string | null => {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8").replace(/\n+$/, "");
  } catch {
    return null;
  }
};

let integrity: string;
switch (verdict.kind) {
  case "clean":
    integrity = "#### Integrity\n\nPassed - this repository matches the state it was stamped with.";
    break;
  case "findings":
    integrity = `#### Integrity\n\n${verdict.findings}\nManaged content changed outside a sync. Restore the file from git history, or re-run the sync, which replaces platform files whole. This FAILS the check.`;
    break;
  case "not-judged":
    integrity = `#### Integrity\n\nNot judged: ${verdict.reason}. See the [run log](${runUrl}). This FAILS the check.`;
    break;
}
const blocking = verdict.kind !== "clean";

// Advisories never gate - they are the validator's own non-failing stream,
// and folding them into the integrity verdict would have a clean
// repository reading as blocked.
const advisories = verdict.kind === "not-judged" ? "" : verdict.advisories;
const advice = advisories === "" ? "" : `\n\n${advisories}`;

/** The `- ` items of a report file (its headings carry only counts). */
const bullets = (text: string | null): string[] =>
  (text ?? "").split("\n").filter((line) => line.startsWith("- "));

// The build tip's validator applies the rules the next sync PR brings, so
// its findings are warnings, never a verdict, and anything the aligned
// validator already reported is not said twice. A latest pass that never
// wrote its findings is a setup failure worth a line, not silence.
const LATEST_HEADING = "#### After your next sync";
const latestSection = (): string => {
  if (!cleared) return "";
  const latestFindings = readReport(latestFindingsFile);
  if (latestFindings === null) {
    return `\n\n${LATEST_HEADING}\n\nThe current template's validator exited before reporting. See the [run log](${runUrl}).`;
  }
  const alreadySaid = new Set([
    ...bullets(verdict.kind === "findings" ? verdict.findings : ""),
    ...bullets(advisories),
  ]);
  const upcoming = [
    ...bullets(latestFindings),
    ...bullets(readReport(latestAdvisoriesFile)),
  ].filter((line) => !alreadySaid.has(line));
  if (upcoming.length === 0) return "";
  return `\n\n${LATEST_HEADING}\n\n${upcoming.join("\n")}\n\nThese are warnings. The next sync brings these rules.`;
};
const latest = latestSection();

// Freshness reads the fetch step's compare, published only once the whole
// admission passed: `ahead` is the build branch ahead of the recorded
// commit, `identical` is up to date, and no compare at all is a run the
// integrity leg refused (or never reached), so the refusal is the reason.
let freshness: string;
let behind = false;
if (compareStatus === "identical") {
  freshness = "#### Freshness\n\nUp to date with the build branch.";
} else if (compareStatus === "ahead") {
  const distance = /^[0-9]+$/.test(aheadBy) ? ` by ${aheadBy} commit(s)` : "";
  freshness = `#### Freshness\n\nThis repository is behind the build branch${distance}. The next sync PR updates the managed files; nothing to do here.`;
  behind = true;
} else {
  const reason =
    verdict.kind === "not-judged"
      ? verdict.reason
      : `the build branch compare reported \`${compareStatus || "nothing"}\``;
  freshness = `#### Freshness\n\nNot checked this run: ${reason}.`;
}

const body = `### Template check\n\n${integrity}${advice}${latest}\n\n${freshness}`;
appendFileSync(summaryFile, `${body}\n`);

// The sticky steps in action.yml read both: the body from the file, and
// `report` to post it (findings) or to delete the comment an earlier run
// left (clean) - a clean, fresh repository has nothing worth a comment.
writeFileSync(commentFile, `${body}\n`);
const worthSaying = blocking || behind || advice !== "" || latest !== "";
appendFileSync(outputFile, `report=${worthSaying ? "findings" : "clean"}\n`);
