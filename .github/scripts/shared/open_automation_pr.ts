#!/usr/bin/env bun
// Commits the working tree onto a rolling automation branch, force-pushes
// it, and creates or refreshes its PR. Shared by the refresh-gitignore and
// refresh-toolchains workflows' "Commit, push, and open PR" steps; each
// run regenerates the branch, so the PR body (and, when REFRESH_TITLE is
// "true", the title) is refreshed to describe what the branch now ships.
// git push authenticates via the checkout step's persisted credentials;
// the gh calls use GH_TOKEN.
//
// Env: BRANCH, BASE_BRANCH, COMMIT_MESSAGE, PR_TITLE, PR_BODY,
// REFRESH_TITLE (optional), GH_TOKEN.

import { env, requireEnv } from "../shared/gha.ts";
import { SYNC_IDENTITY } from "../shared/git_identity.ts";
import { must, mustCapture } from "../shared/proc.ts";

const branch = requireEnv("BRANCH");
const baseBranch = requireEnv("BASE_BRANCH");
const commitMessage = requireEnv("COMMIT_MESSAGE");
const title = requireEnv("PR_TITLE");
const body = requireEnv("PR_BODY");
const refreshTitle = env("REFRESH_TITLE") === "true";

must(["git", "config", "user.name", SYNC_IDENTITY.name]);
must(["git", "config", "user.email", SYNC_IDENTITY.email]);
must(["git", "checkout", "-B", branch]);
// The checkout was clean before the workflow's regeneration step, so the
// dirty set is exactly that step's outputs.
must(["git", "add", "-A"]);
must(["git", "commit", "-m", commitMessage]);
must(["git", "push", "--force", "origin", branch]);

const existing = mustCapture([
  "gh",
  "pr",
  "list",
  "--head",
  branch,
  "--json",
  "number",
  "--jq",
  ".[0].number // empty",
]);
if (existing === "") {
  must([
    "gh",
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ]);
} else {
  // A later run force-pushed fresher content onto the same branch; keep
  // the PR describing what it now ships.
  must(["gh", "pr", "edit", existing, ...(refreshTitle ? ["--title", title] : []), "--body", body]);
}
