#!/usr/bin/env bun
// Commits the working tree onto a rolling automation branch, force-pushes
// it, and creates or refreshes its PR (body always; title when
// REFRESH_TITLE is "true"). git push uses the checkout's credentials.
//
// The lookup is the REST pulls listing with `head=owner:branch`: `gh pr
// list --head` matches on branch name alone (cli/cli#10945) and would
// hand a fork's same-named PR to the edit below.
//
// Env: BRANCH, BASE_BRANCH, COMMIT_MESSAGE, PR_TITLE, PR_BODY,
// GITHUB_REPOSITORY, GH_TOKEN, REFRESH_TITLE and GH_TIMEOUT_MS (optional).

import { z } from "zod";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { SYNC_IDENTITY } from "../shared/git_identity.ts";
import { parseJsonWith } from "../shared/json.ts";
import { must, mustCapture } from "../shared/proc.ts";

const branch = requireEnv("BRANCH");
const baseBranch = requireEnv("BASE_BRANCH");
const commitMessage = requireEnv("COMMIT_MESSAGE");
const title = requireEnv("PR_TITLE");
const body = requireEnv("PR_BODY");
const refreshTitle = env("REFRESH_TITLE") === "true";
const slug = requireEnv("GITHUB_REPOSITORY");
const owner = /^([^/\s]+)\/[^/\s]+$/.exec(slug)?.[1];
if (owner === undefined) fail(`GITHUB_REPOSITORY must be an owner/name slug, not "${slug}"`);

/** Per-call gh deadline: single calls answer in seconds, and the two per
 * run at proc.ts's 300s bound would eat most of the callers' 15-minute
 * job. Capped at 10 minutes so an expiry can still report inside it. */
const MAX_GH_TIMEOUT_MS = 600_000;
const rawTimeout = env("GH_TIMEOUT_MS", "120000");
const GH_TIMEOUT_MS = /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
if (
  !Number.isSafeInteger(GH_TIMEOUT_MS) ||
  GH_TIMEOUT_MS <= 0 ||
  GH_TIMEOUT_MS > MAX_GH_TIMEOUT_MS
) {
  fail(`GH_TIMEOUT_MS must be a decimal integer from 1 to ${MAX_GH_TIMEOUT_MS} milliseconds`);
}

/** gh with the deadline applied; an expiry exits after a line naming the
 * deadline (mustCapture), so a hang is a loud, bounded failure. */
function gh(args: string[]): string {
  return mustCapture(["gh", ...args], { timeoutMs: GH_TIMEOUT_MS });
}

must(["git", "config", "user.name", SYNC_IDENTITY.name]);
must(["git", "config", "user.email", SYNC_IDENTITY.email]);
must(["git", "checkout", "-B", branch]);
// The checkout was clean before the workflow's regeneration step, so the
// dirty set is exactly that step's outputs.
must(["git", "add", "-A"]);
must(["git", "commit", "-m", commitMessage]);
must(["git", "push", "--force", "origin", branch]);

// `head.repo` is null once a fork's repository is deleted.
const openPulls = z.array(
  z.object({
    number: z.number(),
    head: z.object({ repo: z.object({ full_name: z.string() }).nullable() }),
  }),
);
const head = encodeURIComponent(`${owner}:${branch}`);
const listing = gh(["api", `repos/${slug}/pulls?state=open&per_page=100&head=${head}`]);
const pulls = parseJsonWith(openPulls, listing, "gh api pulls");
// The head filter pins the owner and the ref, not the repository; a row
// whose head repository is not this one is never edited, whatever it is.
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const foreign = pulls.filter((pr) => !sameName(pr.head.repo?.full_name ?? "", slug));
if (foreign.length > 0) {
  fail(
    `the pulls listing for ${owner}:${branch} returned PR #${foreign.map((pr) => pr.number).join(", #")} with a head outside ${slug}; refusing to touch it`,
  );
}
if (pulls.length > 1) {
  fail(
    `more than one open PR from ${owner}:${branch} (#${pulls.map((pr) => pr.number).join(", #")}); refusing to guess which one to refresh`,
  );
}

const existing = pulls[0];
if (existing === undefined) {
  const url = gh([
    "pr",
    "create",
    "-R",
    slug,
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ]);
  console.log(url);
} else {
  // A later run force-pushed fresher content onto the same branch; keep
  // the PR describing what it now ships.
  const number = String(existing.number);
  gh([
    "pr",
    "edit",
    number,
    "-R",
    slug,
    ...(refreshTitle ? ["--title", title] : []),
    "--body",
    body,
  ]);
  console.log(`refreshed PR #${number} for ${branch}`);
}
