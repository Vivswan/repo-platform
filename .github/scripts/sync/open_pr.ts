#!/usr/bin/env bun
// Creates or refreshes the sync PR in the target and arms squash
// auto-merge on clean revisions (needs-review ones stay disarmed by the
// earlier disarm_pr.ts step). In branch mode (MODE=branch: the render was
// pushed onto a dispatched branch) the same body is posted as a comment on
// that branch's PR when one exists, and nothing is armed. Invoked by
// reusable-template-sync.yml's "Create or refresh pull request" step.
//
// Env: TARGET, TARGET_DISPLAY (log label; falls back to TARGET),
// HIDE_DETAILS, MODE, DISPLAY, BRANCH, BASE_BRANCH,
// VALIDATION, RECOVER, FORCE_MANUAL, DRIFT_FILE, the env-named section
// files of section_files.ts's PR_BODY_SECTIONS (SUMMARY_FILE,
// CARRIED_FILE, CARRY_REVIEW_FILE, REMOVED_PATHS_FILE,
// MANIFEST_LICENSE_FILE),
// GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT, RUNNER_TEMP.

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { env, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { capture, mustCapture, redactText } from "../shared/proc.ts";
import { clip, escapeControlBytes } from "./preserve_local_content.ts";
import { PR_BODY_SECTIONS } from "./section_files.ts";

const target = requireEnv("TARGET");
const runnerTemp = requireEnv("RUNNER_TEMP");
const repository = requireEnv("GITHUB_REPOSITORY");
const branch = requireEnv("BRANCH");
const display = requireEnv("DISPLAY");
const recover = env("RECOVER");
const validation = env("VALIDATION");

/** bash's `[ -s file ]`: the file exists and is non-empty. */
function nonEmpty(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

/** File content with the trailing newline stripped, like `$(cat file)`. */
function slurp(path: string): string {
  return readFileSync(path, "utf-8").replace(/\n$/, "");
}

// From resolve_refs.ts via file, not a step output: the value is
// target-controlled and step outputs surface in env-group prints. The body
// ships to the private repo, so the VALUE is fine here but its SIZE is
// not: resolve_refs bounds nothing, and the base body sits outside the
// section budget, so an unbounded value would squeeze out the reserved
// validation excerpt. Display-only, so clip it (control bytes escaped - a
// NUL would kill gh's argv); old_commit.txt keeps the real value.
const oldCommit = clip(slurp(join(runnerTemp, "old_commit.txt")));

// TARGET_REF is the verified commit (pinned by resolve_refs.ts), so
// DISPLAY (build@<sha>) drives the source line.
const sourceLine = `[\`${repository}\`](https://github.com/${repository}/tree/build) (build branch)`;

const branchMode = env("MODE") === "branch";
const title = `chore: update repo-platform template to ${display}`;
let body = branchMode
  ? `Template render pushed to \`${branch}\` from ${sourceLine}.

- Previous: \`${oldCommit}\`
- New: \`${display}\`

The commit renders this branch's module selection through the ordinary sync legs (three-way merge, split-file rebuild, retired-file cleanup). Review it with the rest of the PR.`
  : `Automated template update from ${sourceLine}.

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

// The report-file sections, from section_files.ts's one roster (body
// order, render, and whether presence forces the manual-review path).
let sectionsForceReview = false;
for (const section of PR_BODY_SECTIONS) {
  const path = section.env === null ? join(runnerTemp, section.file) : requireEnv(section.env);
  if (!nonEmpty(path)) continue;
  if (section.render !== null) appendSection(`\n\n${section.render(slurp(path))}`);
  sectionsForceReview ||= section.forcesReview;
}

if (validation === "failed") {
  let validationWhere = "details in the sync run log";
  let validationExtra = "";
  if (hideDetails()) {
    // run_hidden.ts hid the diagnostics from the public log; this body ships to the private
    // repo, so they belong here (the filename derives from the run_hidden label, pinned by a
    // check_ssot rule). The promise below is made only once a non-empty capture is in hand.
    validationWhere =
      "the public sync log hides the diagnostics (private repository); reproduce validation locally per docs/private-repos.md";
    for (const file of [join(runnerTemp, "hidden-template-validation.log")]) {
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
// gh reads the body from a file, never from its argv: mustCapture's
// deadline-expiry line prints the whole argv, and a hidden target's body
// carries private hunk text that no mask covers.
const bodyFile = join(runnerTemp, "pr-body.md");
writeFileSync(bodyFile, body);

// Anything that needs human review (each condition below, plus every
// report-file section whose roster entry sets forcesReview, so a new
// section cannot forget the review question) stays manual; a clean update,
// clean side-restore carries included, arms squash auto-merge below.
const needsReview =
  validation === "failed" ||
  recover === "recopy" ||
  env("FORCE_MANUAL") === "true" ||
  sectionsForceReview ||
  nonEmpty(driftFile);

// The PR-URL prints below reach the PUBLIC log even for a hidden target,
// by design: the URL carries the slug plus a PR number and no target
// details, and the slug is the masker's job, not hideDetails' - for a
// private target resolve_private_repo.ts registered the slug (canonical
// and lowercase) with the runner's masker before anything printed, so the
// URL renders as https://github.com/***/pull/N (docs/private-repos.md).
// The mask is a snapshot taken at resolve: a target renamed mid-run
// surfaces under its new slug, the documented residual.
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
// Branch mode: the developer's PR (when one exists) gets the sections as a
// comment and nothing is armed - its own auto-merge waits for the new
// head's checks. Without a PR the body has no private home, so a hidden
// target keeps it off the log and the tail steps carry any failure.
if (branchMode) {
  if (existing === "") {
    console.log(
      `no pull request has ${hideDetails() ? "the branch" : branch} as its head; the render is on the branch, ${
        needsReview
          ? "and its review notes are in this run's step logs (a hidden target's are not printed)"
          : "with nothing to review beyond the diff"
      }`,
    );
    setOutput("url", "");
  } else {
    mustCapture(["gh", "pr", "comment", existing, "-R", target, "--body-file", bodyFile]);
    const prUrl = mustCapture([
      "gh",
      "pr",
      "view",
      existing,
      "-R",
      target,
      "--json",
      "url",
      "--jq",
      ".url",
    ]);
    console.log(`commented on ${prUrl} with the render's notes`);
    setOutput("url", prUrl);
  }
  process.exit(0);
}
let url: string;
if (existing !== "") {
  // Auto-merge was disarmed BEFORE the push (disarm_pr.ts); this step
  // only refreshes the PR and re-arms clean revisions below.
  // The rolling branch is force-pushed over; keep title/body honest.
  mustCapture([
    "gh",
    "pr",
    "edit",
    existing,
    "-R",
    target,
    "--title",
    title,
    "--body-file",
    bodyFile,
  ]);
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
    "--body-file",
    bodyFile,
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
    "auto-merge left off: this PR needs review (conflicts, split-file carries needing " +
      "review, a tripped tail tripwire, failed validation, out-of-band " +
      "settings drift, a referenced-but-undeclared label, a refused mirror declaration, a " +
      "migration rung needing review, a recovery re-render, a forced-manual dispatch, a " +
      "deleted split-class file whose repository-owned half leaves with it, a new starter " +
      "at a path this repository already owns, or a managed file whose local edit the clean " +
      "render replaced).",
  );
}
