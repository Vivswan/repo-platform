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

import { appendFileSync, writeFileSync } from "node:fs";
import { recordedBuildSha } from "./build_sha.ts";
import { capture, notice, requireEnv } from "./runtime.ts";

const NETWORK_TIMEOUT_MS = 20_000;

const templateRepo = requireEnv("TEMPLATE_REPO");
const freshnessFile = requireEnv("FRESHNESS");
const outputFile = requireEnv("GITHUB_OUTPUT");

writeFileSync(freshnessFile, "");
const setState = (state: "fresh" | "behind" | "skipped"): void => {
  appendFileSync(outputFile, `state=${state}\n`);
};
const skip: (reason: string) => never = (reason) => {
  notice(`${reason} Skipping the freshness check.`);
  setState("skipped");
  process.exit(0);
};

// The same read the integrity leg refused on, so a refused `_commit` is
// reported once, there, and only skipped here.
const recorded = recordedBuildSha(".");
if ("refusal" in recorded) skip(recorded.refusal);
const { sha } = recorded;

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

if (tip === sha) {
  setState("fresh");
  process.exit(0);
}

// One more call for the distance. It is presentation only: a failed
// compare still reports "behind", just without the number.
const compare = capture(
  ["gh", "api", `repos/${templateRepo}/compare/${sha}...${tip}`, "--jq", ".ahead_by"],
  { timeoutMs: NETWORK_TIMEOUT_MS },
);
const ahead = compare.exitCode === 0 ? compare.stdout.trim() : "";
const distance = /^[0-9]+$/.test(ahead)
  ? `behind the build branch by ${ahead} commit(s)`
  : "behind the build branch";
writeFileSync(
  freshnessFile,
  `#### Freshness\n\nThis repository is ${distance} (recorded \`${sha.slice(0, 7)}\`, tip \`${tip.slice(0, 7)}\`). The next sync PR updates the managed files; nothing to do here.\n`,
);
setState("behind");
