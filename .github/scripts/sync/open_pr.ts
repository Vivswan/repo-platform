#!/usr/bin/env bun
// Creates or refreshes the sync PR in the target and arms squash
// auto-merge on clean revisions (needs-review ones stay disarmed by the
// earlier disarm_pr.ts step). Invoked by reusable-template-sync.yml's
// "Create or refresh pull request" step.
//
// Env: TARGET, TARGET_DISPLAY (log label; falls back to TARGET),
// HIDE_DETAILS, DISPLAY, BRANCH, BASE_BRANCH,
// VALIDATION, RESOLVED, RECOVER, FORCE_MANUAL, DRIFT_FILE, SUMMARY_FILE,
// CARRIED_FILE, CARRY_REVIEW_FILE, RETIRED_MODULES_FILE,
// REMOVED_PATHS_FILE, WITHHELD_FILE, MANIFEST_LICENSE_FILE,
// GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT,
// RUNNER_TEMP.

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { env, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { capture, mustCapture, redactText } from "../shared/proc.ts";
import { clip, escapeControlBytes } from "./preserve_local_content.ts";
import {
  REMOVED_SPLITS_NAME,
  SETTINGS_LAYERING_NAME,
  STARTER_PINS_NAME,
  TAIL_SHRANK_NAME,
} from "./section_files.ts";

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
// body ships to the private repo, so the VALUE is fine here - but its
// SIZE is not: resolve_refs bounds nothing (a long-but-valid revision
// expression still resolves), and the base body sits outside the section
// budget, so an unbounded value would inflate it until the reserved
// validation excerpt no longer fits. Display-only, so clip it (bounded,
// control bytes escaped - a NUL would kill gh's argv); the real value
// stays in old_commit.txt for anything that consumes it.
const oldCommit = clip(slurp(join(runnerTemp, "old_commit.txt")));

// TARGET_REF is the verified commit (pinned by resolve_refs.ts), so
// DISPLAY (build@<sha>) drives the source line.
const sourceLine = `[\`${repository}\`](https://github.com/${repository}/tree/build) (build branch)`;

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
// anything else. Bounded: the drift report embeds target-controlled
// values, and an unbounded prepend would starve the reserved validation
// section below or trip the end-cutting hard cap that would drop it.
const DRIFT_CAP = 8000;
const driftFile = requireEnv("DRIFT_FILE");
if (nonEmpty(driftFile)) {
  let drift = nulSafe(slurp(driftFile));
  if (Buffer.byteLength(drift, "utf-8") > DRIFT_CAP) {
    // The recovery pointer must hold for HIDDEN targets too: the
    // settings-drift step hides values there, so local reproduction is
    // the one channel that always has the full report.
    drift = `${utf8Truncated(drift, DRIFT_CAP)}\n(drift report truncated: size limit; reproduce the sync locally for the full report - docs/private-repos.md)`;
  }
  body = `${drift}\n\n${body}`;
}

// GitHub caps PR bodies at 64 KiB and gh fails outright past it, stranding
// the pushed branch. Each section below bounds itself, but several near
// their caps (carry, tail tripwire, removed-splits ~16K each, validation
// excerpt ~20K) can SUM past 64 KiB, so an AGGREGATE budget governs the
// whole body: an overflowing section is dropped for the truncation banner.
// The needs-review decision comes from the flag files, never this prose, so
// dropping a section can only lose information, never flip manual to clean.
const BODY_CAP = 62000;
// PRIORITY: the failed-validation section alone gets budget carved out
// before ordinary sections consume it. For a hidden target the PR body is
// the diagnostics' ONLY channel (run_hidden hides the log, the failure
// issue defers to an existing PR) and the workflow error promises them
// here; every other review-forcing section holds the PR via its flag with
// its evidence recoverable elsewhere (base branch, local reproduction).
const VALIDATION_RESERVE = 22000; // EXCERPT_CAP plus framing
/** The validation excerpt's bound, measured on its RE-ENCODED UTF-8 size
 * (see the excerpt construction); must stay under VALIDATION_RESERVE. */
const EXCERPT_CAP = 20000;
let reservedBytes = validation === "failed" ? VALIDATION_RESERVE : 0;
let bodyBytes = Buffer.byteLength(body, "utf-8");
let bodyTruncated = false;

/** Raw NULs escaped visibly: argv cannot carry them, and the escape must
 * run BEFORE a chunk is measured - a NUL-heavy section admitted at raw
 * size would quadruple at a later escape and detour capBody through the
 * reserved section. NUL is never legitimate body content. */
function nulSafe(chunk: string): string {
  return chunk.replaceAll("\0", "\\x00");
}

/** Append `chunk` only if the body stays under the cap MINUS the space
 * reserved for the priority sections; otherwise drop it and remember to
 * add the truncation banner. */
function appendSection(rawChunk: string): void {
  const chunk = nulSafe(rawChunk);
  const chunkBytes = Buffer.byteLength(chunk, "utf-8");
  if (bodyBytes + chunkBytes <= BODY_CAP - reservedBytes) {
    body += chunk;
    bodyBytes += chunkBytes;
  } else {
    bodyTruncated = true;
  }
}

/** Append a priority section, releasing its reservation first: with the
 * drift prepend and every ordinary section bounded, a chunk within the
 * reservation always fits. */
function appendReserved(rawChunk: string): void {
  reservedBytes = 0;
  const chunk = nulSafe(rawChunk);
  const chunkBytes = Buffer.byteLength(chunk, "utf-8");
  if (bodyBytes + chunkBytes <= BODY_CAP) {
    body += chunk;
    bodyBytes += chunkBytes;
  } else {
    bodyTruncated = true;
  }
}

if (recover === "recopy") {
  appendSection(`

> [!WARNING]
> RECOVERY RE-RENDER: this update was dispatched with recover=recopy
> because the recorded template base was unusable. There was no
> three-way merge - local edits to template-managed files are
> overwritten in this diff (repo-owned generated-once files,
> settings.yml, and the marked repository-local sections survive; a
> previous copy that could not be split cleanly is preserved IN FULL
> below a repo-platform:recovery-appendix comment and needs manual
> deduplication), and retired-file cleanup was skipped.
> Review the whole diff before merging.`);
}

// PR-body sections fed by flag files, collected from ONE declarative list:
// each entry names its file (a workflow-provided env path, or a fixed
// RUNNER_TEMP name shared with its writer via section_files.ts), how it
// renders (null = review-only flag, no body section), and whether its
// presence forces the manual-review path. An absent or empty file is no
// section. Order is the body order.
//
// - CARRIED_FILE: preserve_local_content.ts rebuilds every split-class
//   file structurally on every run; its summary names each carried file.
// - tail-shrank: tail_tripwire.ts's post-stamp check - the structural
//   rebuild should make a trip impossible, so a non-empty report is a
//   sync bug and the PR waits for a human.
// - settings-layering: the one-time settings.yml transition
//   (settings_layering.ts) - dropped overrides need a human to re-add the
//   wanted ones.
// - CARRY_REVIEW_FILE: carries that need a human (an appendix, reset
//   managed-half edits, duplicate markers) - review-only, the carried
//   summary already names the files.
interface FlagSection {
  path: string;
  /** Renders the section body (called only on a non-empty file); null
   * marks a review-only flag with no body section of its own. */
  render: ((path: string) => string) | null;
  /** A present section forces the manual-review path. */
  forcesReview: boolean;
}

const sections: FlagSection[] = [
  { path: requireEnv("CARRIED_FILE"), render: slurp, forcesReview: false },
  { path: join(runnerTemp, TAIL_SHRANK_NAME), render: slurp, forcesReview: true },
  {
    path: requireEnv("RETIRED_MODULES_FILE"),
    render: (path) => `Retired modules dropped from the selection: ${lines(path).join(", ")}`,
    forcesReview: false,
  },
  {
    path: requireEnv("REMOVED_PATHS_FILE"),
    render: (path) =>
      `The template retired these files; this update deletes them:\n\n${lines(path)
        .map((rel) => `- ${rel}`)
        .join("\n")}`,
    forcesReview: false,
  },
  // starter_pin_rollout.ts's transition note: the one-run port of starter
  // workflows' action pins onto the delivery branch. Informational, like
  // the retired-file list above - the rewrite is byte-surgical and
  // exact-match-only, and hand-set pins are listed but deliberately left
  // alone - so it never forces the manual path by itself.
  { path: join(runnerTemp, STARTER_PINS_NAME), render: slurp, forcesReview: false },
  {
    path: requireEnv("WITHHELD_FILE"),
    render: (path) => `> [!WARNING]
> Workflow-file changes were WITHHELD from this update: the sync
> token lacks the Workflows scope. Grant Workflows read/write to
> the REPO_PLATFORM_TOKEN and re-run the sync to include them.

${lines(path)
  .map((rel) => `- ${rel}`)
  .join("\n")}`,
    forcesReview: true,
  },
  { path: requireEnv("MANIFEST_LICENSE_FILE"), render: slurp, forcesReview: false },
  { path: join(runnerTemp, SETTINGS_LAYERING_NAME), render: slurp, forcesReview: true },
  // preserve_repo_owned.ts's removed-split-files report: the update
  // deletes a path whose previous copy carried a repository-owned half
  // (class `split` at HEAD, or a license spelling the manifest cannot
  // class); the section names the content that leaves and the PR waits
  // for a human to restore what must stay.
  { path: join(runnerTemp, REMOVED_SPLITS_NAME), render: slurp, forcesReview: true },
  { path: requireEnv("CARRY_REVIEW_FILE"), render: null, forcesReview: true },
];
let sectionsForceReview = false;
for (const section of sections) {
  if (!nonEmpty(section.path)) continue;
  if (section.render !== null) appendSection(`\n\n${section.render(section.path)}`);
  sectionsForceReview ||= section.forcesReview;
}

if (resolved === "true") {
  appendSection(`

> [!WARNING]
> copier hit merge conflicts, resolved below in favor of the
> template where possible. Restore any dropped local lines that
> should stay, and hand-edit anything marked unresolved, before
> merging.

${slurp(requireEnv("SUMMARY_FILE"))}`);
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
        // The excerpt is bounded on its re-encoded UTF-8 size (invalid
        // capture bytes decode to 3-byte U+FFFD replacements, so a raw
        // byte slice could exceed the reservation), and only a bounded
        // PREFIX of the capture is ever read or decoded (run_hidden
        // writes it uncapped; a decoded byte never shrinks its input, so
        // EXCERPT_CAP input bytes plus lookahead for a straddling char
        // already saturate the excerpt).
        const size = statSync(file).size;
        const window = Math.min(size, EXCERPT_CAP + 3);
        const prefix = Buffer.alloc(window);
        const fd = openSync(file, "r");
        let read = 0;
        try {
          read = readSync(fd, prefix, 0, window, 0);
        } finally {
          closeSync(fd);
        }
        const decoded = prefix.subarray(0, read).toString("utf-8");
        // Raw control bytes decode VERBATIM (unlike invalid bytes), so
        // escape BEFORE the byte cap and measure the escaped text - the
        // reservation math must hold post-escaping. LF/CR stay literal
        // (block structure).
        const escaped = escapeControlBytes(decoded, true);
        const excerpt = utf8Truncated(escaped, EXCERPT_CAP);
        const note =
          size > read || excerpt.length < escaped.length
            ? "\n(truncated; reproduce validation locally for the rest - docs/private-repos.md)"
            : "";
        validationExtra = `\n\n\`\`\`\`text\n${excerpt}${note}\n\`\`\`\``;
        break;
      }
    }
  }
  appendReserved(`

> [!WARNING]
> Validation failed on the updated tree (${validationWhere}). Fix it
> in this PR before merging.${validationExtra}`);
}

// One truncation banner when the aggregate budget dropped any section, so
// the reader knows the body is incomplete and where the rest lives. It is
// short and BODY_CAP leaves ample headroom under GitHub's 64 KiB limit, so
// this final append never overflows.
if (bodyTruncated) {
  body += `

> [!WARNING]
> This PR body was truncated to stay under GitHub's size limit: one or
> more sections above were omitted. Inspect this sync run's log and the
> base branch for the full detail before merging.`;
}

/** `text` truncated to at most `budget` UTF-8 bytes: whole trailing lines
 * are dropped first so no markdown is cut mid-line; a single over-budget
 * line is byte-cut on a char boundary. */
function utf8Truncated(text: string, budget: number): string {
  const lines = text.split("\n");
  while (lines.length > 1 && Buffer.byteLength(lines.join("\n"), "utf-8") > budget) {
    lines.pop();
  }
  let head = lines.join("\n");
  if (Buffer.byteLength(head, "utf-8") > budget) {
    const buf = Buffer.from(head, "utf-8");
    let end = budget;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back off a continuation byte
    head = buf.subarray(0, end).toString("utf-8");
  }
  return head;
}

// Backstop the aggregate budget: appendSection/appendReserved govern the
// optional sections and the drift prepend is bounded at its source, so
// this should never fire - it stays as the final guarantee that no future
// unbounded append can hand gh an over-limit body and strand the branch.
const HARD_CAP = 63000;
function capBody(full: string): string {
  if (Buffer.byteLength(full, "utf-8") <= HARD_CAP) return full;
  const notice =
    "\n\n> [!WARNING]\n> This PR body exceeded GitHub's size limit and was hard-truncated;" +
    " inspect this sync run's log and the base branch for the rest before merging.";
  return utf8Truncated(full, HARD_CAP - Buffer.byteLength(notice, "utf-8")) + notice;
}
// Backstop at the spawn boundary: every measured chunk is already
// nulSafe'd, so this catches only base-body residue - one raw NUL would
// fail `gh pr create/edit` outright and lose the delivery channel.
body = nulSafe(body);
body = capBody(body);

// Anything that needs human review - dropped local hunks, a split-file
// carry that needs a human (appendix, reset managed-half edits, duplicate
// markers), a tripped tail tripwire, withheld workflow files, failed
// validation, a recovery re-render, a dispatch that forced manual review,
// a deleted split-class file (its repository-owned half leaves with it),
// out-of-band settings drift, dropped settings-layering overrides - stays
// manual; a clean update (which includes kept-whole and clean
// tail-appended carries) arms squash auto-merge below. The flag-file
// reasons ride the section list above (forcesReview), so a new section
// cannot forget the review question.
const needsReview =
  resolved === "true" ||
  validation === "failed" ||
  recover === "recopy" ||
  env("FORCE_MANUAL") === "true" ||
  sectionsForceReview ||
  nonEmpty(driftFile);

// The PR-URL prints below reach the PUBLIC log even for a hidden target -
// accepted by design. The URL carries the slug plus a PR number and no
// target details, and the slug is the NAME-redaction side's job, not
// hideDetails': for a wildcard-discovered private target,
// resolve_private_repo.ts registered the slug (canonical and lowercase
// forms) with the runner's masker before anything printed, so the URL
// renders as https://github.com/***/pull/N - docs/private-repos.md names
// PR URLs as a masker-covered surface - while a hide-details target whose
// name is NOT masked is self-disclosed (an explicit repos.yml entry,
// already plain in the public job name). The mask is a point-in-time
// snapshot taken at the resolve step: a target renamed mid-run surfaces
// here under its new canonical slug, which no mask covers - the
// documented residual (a rename BEFORE resolve fails closed there).
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
  // Both merge streams can name the target's rulesets and required
  // checks, so a hidden target's stdout stays off the public log like the
  // stderr detail below; redacted, and writeSync so a later exit cannot
  // truncate it at the pipe buffer.
  if (!hideDetails()) writeSync(1, redactText(merge.stdout));
  if (merge.exitCode === 0) {
    console.log(`auto-merge armed for ${url}`);
  } else {
    // gh's error text can name the target's rulesets and required checks.
    const detail = hideDetails()
      ? "detail hidden: private repository"
      : redactText(merge.stderr).replace(/\n$/, "");
    console.log(
      `::warning::${env("TARGET_DISPLAY") || target}: could not enable auto-merge on ${url}: ${detail}. Merge it manually; to fix this, allow auto-merge in the repo settings and keep a required check on the default branch.`,
    );
  }
} else {
  console.log(
    "auto-merge left off: this PR needs review (conflicts, split-file carries needing review, a tripped tail tripwire, withheld files, failed validation, out-of-band settings drift, dropped settings-layering overrides, a recovery re-render, a forced-manual dispatch, or a deleted split-class file whose repository-owned half leaves with it).",
  );
}
