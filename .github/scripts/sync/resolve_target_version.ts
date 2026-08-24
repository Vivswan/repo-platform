#!/usr/bin/env bun
// Resolves the release tag latest-channel repos sync to, for
// sync-repos.yml's plan job. A dispatch's explicit version wins;
// otherwise the newest stable release is the ground truth. The release
// event's tag is never trusted as the sync target: a release published
// on an older tag must not roll the latest channel backwards, so a
// differing event tag only gets a notice.
//
// Env: GH_TOKEN, RELEASE_TAG, REQUESTED, GITHUB_REPOSITORY,
// GITHUB_OUTPUT.

import { env, error, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";

const repository = requireEnv("GITHUB_REPOSITORY");
const requested = env("REQUESTED");
const releaseTag = env("RELEASE_TAG");

let version = requested;
if (requested === "") {
  const latest = capture(["gh", "api", `repos/${repository}/releases/latest`, "--jq", ".tag_name"]);
  if (latest.exitCode === 0) {
    version = latest.stdout.replace(/\n+$/, "");
  } else if (latest.stderr.includes("HTTP 404")) {
    // Only HTTP 404 means no release exists (fine for a staging-only
    // fleet; a latest-channel sync leg fails with its own actionable
    // error). Anything else is an API failure that must not read as
    // "no release yet" - that would sync latest-channel repos to
    // nothing (or a notice-only stale version) while staying green.
    version = "";
    console.log("No release yet; syncing without a version.");
  } else {
    error(
      `reading ${repository}'s latest release failed - an API failure, not a missing release; re-run the sync.`,
    );
    process.stderr.write(latest.stderr);
    process.exit(1);
  }
}

if (releaseTag !== "" && releaseTag !== version) {
  notice(
    `published release ${releaseTag} is not the newest stable release (${version || "none exists"}); latest-channel repos sync to the newest stable release instead.`,
  );
}
console.log(`version=${version}`);
setOutput("version", version);
