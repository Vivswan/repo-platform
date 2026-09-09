#!/usr/bin/env bun
// The module-render check's first step, run from the caller's checkout: a
// pull request that leaves both selection files alone needs no render, and
// one that changes them gets its recorded _commit admitted as a published
// build-branch commit before the render step runs that commit's hooks with
// --trust (the same admission validate-template-report makes).
//
// Env: GH_TOKEN, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY,
// GITHUB_OUTPUT. Output: render=true|false.

import { appendFileSync, readFileSync } from "node:fs";
import {
  capture,
  env,
  error,
  failureDetail,
  requireEnv,
  succeeded,
} from "../../shared/action_runtime.ts";
import { admitBuildCommit } from "../../shared/build_sha.ts";
import { ANSWERS_PATH, REGISTRATION_PATH, readSelection, SELECTION_PATHS } from "./selection.ts";

const NETWORK_TIMEOUT_MS = 60_000;

const outputFile = requireEnv("GITHUB_OUTPUT");
// Explicitly typed so a call narrows the flow (a never-returning arrow
// bound without the annotation does not).
const conclude: (render: boolean, code: number) => never = (render, code) => {
  appendFileSync(outputFile, `render=${render}\n`);
  process.exit(code);
};
const stop: (reason: string) => never = (reason) => {
  console.log(`::notice::module-render: ${reason}.`);
  conclude(false, 0);
};
const refuse: (reason: string) => never = (reason) => {
  error(`module-render: ${reason}.`);
  conclude(false, 1);
};

if (env("GITHUB_EVENT_NAME") !== "pull_request") {
  stop("not a pull request event, so there is no selection change to judge");
}
const event = JSON.parse(readFileSync(requireEnv("GITHUB_EVENT_PATH"), "utf-8")) as {
  pull_request?: { number?: unknown };
};
const number = event.pull_request?.number;
if (typeof number !== "number") refuse("the event payload carries no pull_request.number");
const repository = requireEnv("GITHUB_REPOSITORY");
const listed = capture(
  ["gh", "api", `repos/${repository}/pulls/${number}/files`, "--paginate", "--jq", ".[].filename"],
  { timeoutMs: NETWORK_TIMEOUT_MS },
);
if (!succeeded(listed.exit)) {
  refuse(`could not list the pull request's files: ${failureDetail(listed)}`);
}
const changed = listed.stdout.split("\n").filter((path) => SELECTION_PATHS.includes(path));
if (changed.length === 0) {
  stop(
    `the pull request changes neither ${REGISTRATION_PATH} nor ${ANSWERS_PATH}; the managed files stand as validate-template judged them`,
  );
}

const read = readSelection(".");
if ("refusal" in read) refuse(read.refusal);
const { commit } = read.selection;
// The render runs this commit's hooks with --trust; admitBuildCommit
// states why only a published build-branch commit may.
const admitted = admitBuildCommit(commit, NETWORK_TIMEOUT_MS);
if ("refusal" in admitted)
  refuse(`${admitted.refusal}, so its render hooks cannot be trusted here`);
console.log(
  `module-render: ${changed.join(" and ")} changed; rendering the selection at ${commit}`,
);
conclude(true, 0);
