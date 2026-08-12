#!/usr/bin/env bun
// Decides which build branches to (re)build for this event. Invoked by
// build-branches.yml's "Plan builds" step.
//
// Env: EVENT_NAME, DISPATCH_CHANNEL, RELEASE_TAG, GH_TOKEN,
// GITHUB_REPOSITORY, GITHUB_OUTPUT.

import { env, requireEnv, setOutput } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";

const eventName = requireEnv("EVENT_NAME");
const dispatchChannel = env("DISPATCH_CHANNEL") || "both";
const repository = requireEnv("GITHUB_REPOSITORY");

function latestReleaseTag(): string {
  // gh api prints the error body to stdout on 404; only keep output from
  // a successful call.
  const release = capture([
    "gh",
    "api",
    `repos/${repository}/releases/latest`,
    "--jq",
    ".tag_name",
  ]);
  if (release.exitCode === 0) {
    return release.stdout.trimEnd();
  }
  // Only HTTP 404 means "no release exists". Any other failure is an
  // operational problem (rate limit, auth, outage) and must fail the plan:
  // reading it as "no release yet" would skip the latest build (and the
  // self-heal path) while the workflow reports success.
  if (/HTTP 404/.test(release.stderr)) {
    return "";
  }
  throw new Error(`gh api releases/latest failed (${release.exitCode}): ${release.stderr.trim()}`);
}

function remoteRefExists(ref: string): boolean {
  return capture(["git", "ls-remote", "--exit-code", "origin", ref]).exitCode === 0;
}

let buildStaging = false;
let buildLatest = false;
let latestVer = "";
if (eventName === "push" || eventName === "schedule") {
  buildStaging = true;
} else if (eventName === "workflow_dispatch") {
  if (dispatchChannel === "both" || dispatchChannel === "staging") {
    buildStaging = true;
  }
}
if (eventName === "release") {
  buildLatest = true;
  latestVer = requireEnv("RELEASE_TAG");
} else if (eventName === "workflow_dispatch" && dispatchChannel !== "staging") {
  // Manual dispatch rebuilds latest unconditionally (idempotent: unchanged
  // content appends nothing, existing tags are kept).
  latestVer = latestReleaseTag();
  if (latestVer !== "") {
    buildLatest = true;
  } else {
    console.log("No release yet; latest branch not built.");
  }
} else if (eventName !== "workflow_dispatch") {
  // Self-heal: rebuild latest when its build tag or branch is missing.
  latestVer = latestReleaseTag();
  if (latestVer !== "") {
    if (
      !remoteRefExists(`refs/tags/templates/${latestVer}`) ||
      !remoteRefExists("refs/heads/latest")
    ) {
      buildLatest = true;
    }
  } else {
    console.log("No release yet; latest branch not built.");
  }
}
setOutput("staging", String(buildStaging));
setOutput("latest", String(buildLatest));
setOutput("version", latestVer);
console.log(`plan: staging=${buildStaging} latest=${buildLatest} version=${latestVer}`);
