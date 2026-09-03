#!/usr/bin/env bun
// The FRESHNESS leg of the validate-template report: one ref compare
// answering "how far behind the build branch is this repo". It is never
// the repository's fault and never its blocker - the next sync PR closes
// it - so this script informs and nothing more: no copier, no render, and
// its OWN failures (network, an operator repo this token cannot read) skip
// with a notice instead of going red (the calling step also carries
// continue-on-error as a belt).
//
// Writes state=fresh|behind|skipped to GITHUB_OUTPUT, and - only when
// behind - a markdown fragment to $FRESHNESS for report.ts to splice.
//
// Env: GH_TOKEN, TEMPLATE_REPO (the operator repository), FRESHNESS,
// GITHUB_OUTPUT. Runs from the caller's checkout, where copier recorded
// its answers.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { capture, notice, requireEnv } from "./runtime.ts";

const NETWORK_TIMEOUT_MS = 20_000;

const templateRepo = requireEnv("TEMPLATE_REPO");
const freshnessFile = requireEnv("FRESHNESS");
const outputFile = requireEnv("GITHUB_OUTPUT");

writeFileSync(freshnessFile, "");
const setState = (state: "fresh" | "behind" | "skipped"): void => {
  appendFileSync(outputFile, `state=${state}\n`);
};
const skip = (reason: string): never => {
  notice(`${reason} Skipping the freshness check.`);
  setState("skipped");
  process.exit(0);
};

let answers = "";
try {
  answers = readFileSync(".github/.copier-answers.yml", "utf8");
} catch {
  // Fine: the empty string yields no recorded commit, which skips below.
}
// copier's recorded template commit. YAML quotes the sha whenever it would
// parse as a number, so quotes (and stray spaces) are stripped anywhere,
// exactly as the inline bash predecessor's tr did.
const recordedLine = answers.split("\n").find((line) => line.startsWith("_commit:"));
const recorded = (recordedLine ?? "").replace(/^_commit:/, "").replace(/["' ]/g, "");
if (recorded === "") skip("No _commit is recorded in .github/.copier-answers.yml.");

const tipProbe = capture(
  ["gh", "api", `repos/${templateRepo}/branches/build`, "--jq", ".commit.sha"],
  { timeoutMs: NETWORK_TIMEOUT_MS },
);
if (tipProbe.exitCode !== 0) {
  skip(
    `Could not read ${templateRepo}'s build branch (network, or a private operator repo this token cannot read).`,
  );
}
const tip = tipProbe.stdout.trim();
if (tip === "") skip(`${templateRepo}'s build branch reported no commit.`);

// The recorded value is copier's short sha, so match on prefix.
if (tip.startsWith(recorded)) {
  setState("fresh");
  process.exit(0);
}

// One more call for the distance. It is presentation only: a failed
// compare still reports "behind", just without the number.
const compare = capture(
  ["gh", "api", `repos/${templateRepo}/compare/${recorded}...${tip}`, "--jq", ".ahead_by"],
  { timeoutMs: NETWORK_TIMEOUT_MS },
);
const ahead = compare.exitCode === 0 ? compare.stdout.trim() : "";
const distance = /^[0-9]+$/.test(ahead)
  ? `behind the build branch by ${ahead} commit(s)`
  : "behind the build branch";
writeFileSync(
  freshnessFile,
  `#### Freshness\n\nThis repository is ${distance} (recorded \`${recorded}\`, tip \`${tip.slice(0, 7)}\`). The next sync PR updates the managed files; nothing to do here.\n`,
);
setState("behind");
