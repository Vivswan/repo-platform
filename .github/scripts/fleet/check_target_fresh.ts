#!/usr/bin/env bun

// Last-moment freshness check for a settings apply. The opt-in and every
// fact were read at one pinned commit; this step re-resolves the target's
// default-branch head immediately before the mutation and reports whether
// it still matches.
//
// It NARROWS the window between "we decided this repo is managed" and "we
// reconcile its labels" down to this step. It cannot close it: the
// settings API has no compare-and-swap on "this repository is still
// managed", so a push landing inside the remaining window still applies. A moved head is not an error - the next run reads the new
// revision - so this reports and lets the caller gate.
//
// Env: GH_TOKEN, TARGET (owner/name), PINNED (the render's sha).
//
// The output here quotes commit shas, and the resolver's failure strings
// name the target's default BRANCH - so settings-repos.yml runs this step
// behind the same run_hidden.ts boundary as the render and the merge for
// a hide-details target (docs/settings.md, the private-target bullet).

import { env, fail, requireEnv, setOutput, warning } from "../shared/gha.ts";
import { captureNetwork } from "./discovery.ts";

/** The commit every read for a target pins to: its default branch's head. */
function resolveTargetRef(repo: string): string {
  const branchProc = captureNetwork(["gh", "api", `repos/${repo}`, "--jq", ".default_branch"]);
  if (branchProc.exitCode !== 0) {
    throw new Error(
      `${repo}: cannot read the default branch (${branchProc.stderr.trim().split("\n")[0]})`,
    );
  }
  const branch = branchProc.stdout.trim();
  const head = captureNetwork(["gh", "api", `repos/${repo}/commits/${branch}`, "--jq", ".sha"]);
  if (head.exitCode !== 0) {
    throw new Error(`${repo}: cannot resolve ${branch} (${head.stderr.trim().split("\n")[0]})`);
  }
  const sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${repo}: ${branch} resolved to no commit sha`);
  }
  return sha;
}

const target = requireEnv("TARGET");
// Read UNSET rather than required: an absent pin is a specific failure
// with a specific cause, and it is the one this script exists to refuse.
const pinned = env("PINNED", "");

// Every fact source pins - a fetch to the resolved head, a local checkout
// to its own HEAD - so an empty pin means the render published nothing to
// compare against, not that there is nothing to compare. Refuse: the
// apply gates on `moved == 'false'`, and guessing "false" here would be
// the one path that reaches a mutation unchecked.
if (pinned === "") {
  fail(
    `${target}: no pinned commit to check freshness against. The render publishes one for every ` +
      "fact source; an empty value means it did not run, or ran against a directory that is not " +
      "a git checkout.",
  );
}

const head = resolveTargetRef(target);
const moved = head !== pinned;
if (moved) {
  warning(
    `${target}: the default branch moved from ${pinned} to ${head} while this run was ` +
      "computing its settings, so the apply is SKIPPED rather than applied from a stale " +
      "snapshot - the module selection may have changed with it. The next run reads the " +
      "new revision.",
  );
}
setOutput("moved", String(moved));
