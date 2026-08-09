#!/usr/bin/env bun
// Creates or refreshes the sync PR in the target and arms squash
// auto-merge on clean revisions (needs-review ones stay disarmed by the
// earlier disarm_pr.ts step). Invoked by reusable-template-sync.yml's
// "Create or refresh pull request" step.
//
// Env: TARGET, TARGET_DISPLAY (log label; falls back to TARGET),
// HIDE_DETAILS, CHANNEL, DISPLAY, BRANCH, BASE_BRANCH,
// VALIDATION, RESOLVED, RECOVER, FORCE_MANUAL, DRIFT_FILE, SUMMARY_FILE,
// RETIRED_MODULES_FILE, REMOVED_PATHS_FILE, WITHHELD_FILE,
// MANIFEST_LICENSE_FILE, LICENSE_TRANSITION_FILE, GH_TOKEN,
// GITHUB_REPOSITORY, GITHUB_OUTPUT, RUNNER_TEMP.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { env, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { capture, mustCapture } from "../shared/proc.ts";

const target = requireEnv("TARGET");
const runnerTemp = requireEnv("RUNNER_TEMP");
const repository = requireEnv("GITHUB_REPOSITORY");
const branch = requireEnv("BRANCH");
const display = requireEnv("DISPLAY");
const recover = env("RECOVER");
const resolved = env("RESOLVED");
const validation = env("VALIDATION");

/** bash's `[ -s file ]`: the file exists and is non-empty. */
function nonEmpty(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

/** File content with the trailing newline stripped, like `$(cat file)`. */
function slurp(path: string): string {
  return readFileSync(path, "utf-8").replace(/\n$/, "");
}

function lines(path: string): string[] {
  return slurp(path)
    .split("\n")
    .filter((line) => line !== "");
}

// From resolve_refs.ts via file (not a step output: the value is
// target-controlled and step outputs surface in env-group prints). This
// body ships to the private repo, so the raw value is fine HERE.
const oldCommit = readFileSync(join(runnerTemp, "old_commit.txt"), "utf-8");

// TARGET_REF is the verified commit on both channels (pinned by
// resolve_refs.ts), so the channel and DISPLAY (staging@<sha> or
// templates/vX.Y.Z) drive the source line.
const sourceLine =
  requireEnv("CHANNEL") === "staging"
    ? `[\`${repository}\`](https://github.com/${repository}/tree/staging) (staging channel)`
    : `[\`${repository}\`](https://github.com/${repository}/releases/tag/${display.replace(/^templates\//, "")})`;

const title = `chore: update repo-platform template to ${display}`;
let body = `Automated template update from ${sourceLine}.

- Previous: \`${oldCommit}\`
- New: \`${display}\`

Review any merge conflicts and confirm repository-local sections were preserved before merging.

> [!NOTE]
> This branch is regenerated on every sync run; manual commits
> pushed to it are overwritten. Make fixes in a separate branch or
> after merging.`;

// Out-of-band settings drift goes on TOP of the body: merging ratifies
// live values no human declared, so the reader must see that before
// anything else.
const driftFile = requireEnv("DRIFT_FILE");
if (nonEmpty(driftFile)) {
  body = `${slurp(driftFile)}\n\n${body}`;
}

if (recover === "recopy") {
  body += `

> [!WARNING]
> RECOVERY RE-RENDER: this update was dispatched with recover=recopy
> because the recorded template base was unusable. There was no
> three-way merge - local edits to template-managed files are
> overwritten in this diff (repo-owned generated-once files and
> settings.yml survive), and retired-file cleanup was skipped.
> Review the whole diff before merging.`;
}

const retiredModulesFile = requireEnv("RETIRED_MODULES_FILE");
if (nonEmpty(retiredModulesFile)) {
  body += `\n\nRetired modules dropped from the selection: ${lines(retiredModulesFile).join(", ")}`;
}

const removedPathsFile = requireEnv("REMOVED_PATHS_FILE");
if (nonEmpty(removedPathsFile)) {
  body += `\n\nThe template retired these files; this update deletes them:\n\n${lines(
    removedPathsFile,
  )
    .map((path) => `- ${path}`)
    .join("\n")}`;
}

const withheldFile = requireEnv("WITHHELD_FILE");
if (nonEmpty(withheldFile)) {
  body += `

> [!WARNING]
> Workflow-file changes were WITHHELD from this update: the sync
> token lacks the Workflows scope. Grant Workflows read/write to
> the REPO_PLATFORM_TOKEN and re-run the sync to include them.

${lines(withheldFile)
  .map((path) => `- ${path}`)
  .join("\n")}`;
}

const manifestLicenseFile = requireEnv("MANIFEST_LICENSE_FILE");
if (nonEmpty(manifestLicenseFile)) {
  body += `\n\n${slurp(manifestLicenseFile)}`;
}

const licenseTransitionFile = requireEnv("LICENSE_TRANSITION_FILE");
if (nonEmpty(licenseTransitionFile)) {
  body += `

> [!WARNING]
> This update DELETES ${lines(licenseTransitionFile).join(" and ")}. Copier
> resolves delete-vs-modify by dropping the file, so content below its
> local-section marker (prior-license notices) is not in this diff -
> recover it from the base branch or git history and port it below
> LICENSE.md's marker on this branch before merging.`;
}

if (resolved === "true") {
  body += `

> [!WARNING]
> copier hit merge conflicts, resolved below in favor of the
> template where possible. Restore any dropped local lines that
> should stay, and hand-edit anything marked unresolved, before
> merging.

${slurp(requireEnv("SUMMARY_FILE"))}`;
}

if (validation === "failed") {
  let validationWhere = "details in the sync run log";
  let validationExtra = "";
  if (hideDetails()) {
    // run_hidden.ts withheld the diagnostics from the public log; this
    // body ships to the private repo, so they belong here instead. The
    // post-withhold re-validation supersedes the full-tree run. The
    // filenames derive from the run_hidden labels - a check_ssot rule
    // pins the two sides. The promise of diagnostics below is only made
    // once a non-empty capture is actually in hand.
    validationWhere =
      "the public sync log hides the diagnostics (private repository); reproduce validation locally per docs/private-repos.md";
    for (const file of [
      join(runnerTemp, "hidden-post-withhold-re-validation.log"),
      join(runnerTemp, "hidden-template-validation.log"),
    ]) {
      if (nonEmpty(file)) {
        validationWhere =
          "the public sync log hides the diagnostics (private repository); they are below";
        // GitHub caps PR bodies at 64 KiB and gh fails outright past it,
        // which would strand the pushed branch with no PR - keep the
        // excerpt bounded like the conflicts summary.
        const data = readFileSync(file);
        const note =
          data.length > 20000
            ? "\n(truncated; reproduce validation locally for the rest - docs/private-repos.md)"
            : "";
        const excerpt = data.subarray(0, 20000).toString("utf-8");
        validationExtra = `\n\n\`\`\`\`text\n${excerpt}${note}\n\`\`\`\``;
        break;
      }
    }
  }
  body += `

> [!WARNING]
> Validation failed on the updated tree (${validationWhere}). Fix it
> in this PR before merging.${validationExtra}`;
}

// Anything that needs human review - dropped local hunks, withheld
// workflow files, failed validation, a recovery re-render, a dispatch
// that forced manual review, a deleted license file, out-of-band
// settings drift - stays manual; a clean update arms squash auto-merge
// below.
const needsReview =
  resolved === "true" ||
  validation === "failed" ||
  recover === "recopy" ||
  env("FORCE_MANUAL") === "true" ||
  nonEmpty(licenseTransitionFile) ||
  nonEmpty(withheldFile) ||
  nonEmpty(driftFile);

const existing = mustCapture([
  "gh",
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
let url: string;
if (existing !== "") {
  // Auto-merge was disarmed BEFORE the push (disarm_pr.ts); this step
  // only refreshes the PR and re-arms clean revisions below.
  // The rolling branch is force-pushed over; keep title/body honest.
  mustCapture(["gh", "pr", "edit", existing, "-R", target, "--title", title, "--body", body]);
  url = mustCapture(["gh", "pr", "view", existing, "-R", target, "--json", "url", "--jq", ".url"]);
  console.log(`PR already exists for ${branch}; refreshed ${url}`);
} else {
  url = mustCapture([
    "gh",
    "pr",
    "create",
    "-R",
    target,
    "--base",
    requireEnv("BASE_BRANCH"),
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ]);
  console.log(`Created ${url}`);
}
setOutput("url", url);

// Squash auto-merge on the CLEAN path: the PR merges itself once the
// target's required checks (all-green) pass. Needs-review revisions stay
// disarmed (disarm_pr.ts ran before the push; a fresh PR is never armed).
if (!needsReview) {
  const merge = capture(["gh", "pr", "merge", url, "-R", target, "--squash", "--auto"]);
  process.stdout.write(merge.stdout);
  if (merge.exitCode === 0) {
    console.log(`auto-merge armed for ${url}`);
  } else {
    // gh's error text can name the target's rulesets and required checks.
    const detail = hideDetails()
      ? "detail hidden: private repository"
      : merge.stderr.replace(/\n$/, "");
    console.log(
      `::warning::${env("TARGET_DISPLAY") || target}: could not enable auto-merge on ${url}: ${detail}. Merge it manually; to fix this, allow auto-merge in the repo settings and keep a required check on the default branch.`,
    );
  }
} else {
  console.log(
    "auto-merge left off: this PR needs review (conflicts, withheld files, failed validation, out-of-band settings drift, a recovery re-render, a forced-manual dispatch, or a deleted license file).",
  );
}
