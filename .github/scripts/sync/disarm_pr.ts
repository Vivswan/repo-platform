#!/usr/bin/env bun
// Disarms auto-merge on the existing rolling PR BEFORE the branch is
// (re)pushed: the incoming revision may need review, and between a push
// and a later disarm an armed PR could merge it (or stay armed if the
// disarm call failed). open_pr.ts re-arms clean revisions after the
// push; a run that pushes nothing leaves the now-stale PR safely
// disarmed. Invoked by reusable-template-sync.yml's "Disarm auto-merge
// before the branch changes" step.
//
// Env: TARGET, BRANCH, GH_TOKEN.

import { requireEnv } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";

const target = requireEnv("TARGET");
const branch = requireEnv("BRANCH");

// capture(), not mustCapture: the argv carries the target slug (private
// for hide-details repos), and mustCapture's deadline-expiry line prints
// the whole argv. This wrapper prints the program name alone and re-emits
// gh's own stderr as the previous inherit did.
function gh(args: string[]): string {
  const proc = capture(["gh", ...args]);
  process.stderr.write(proc.stderr);
  if (proc.exitCode !== 0) {
    if (proc.timedOut) console.error("gh timed out (proc.ts hang bound)");
    process.exit(proc.exitCode);
  }
  return proc.stdout.trimEnd();
}

const existing = gh([
  "pr",
  "list",
  "-R",
  target,
  "--head",
  branch,
  "--json",
  "number",
  "--jq",
  ".[0].number // empty",
]);
if (existing === "") process.exit(0);
// Query first so a real API failure fails the step instead of being
// mistaken for "already off"; only an actually armed PR gets disabled,
// and a failed disable fails the step before anything is pushed.
const armed = gh([
  "pr",
  "view",
  existing,
  "-R",
  target,
  "--json",
  "autoMergeRequest",
  "--jq",
  ".autoMergeRequest != null",
]);
if (armed === "true") {
  gh(["pr", "merge", existing, "-R", target, "--disable-auto"]);
  console.log(`auto-merge disarmed on PR #${existing} while the branch is regenerated`);
} else {
  console.log(`PR #${existing} exists with auto-merge off; nothing to disarm`);
}
