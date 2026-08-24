#!/usr/bin/env bun
// Failure-report issue on the target repo: a hide-details target's issues
// are as private as the repo, so the full run_hidden.ts captures are safe
// there when no sync PR exists to carry them. Invoked by
// reusable-template-sync.yml's tail steps.
//
// deliver (failed run): replace the issue body with every recorded hidden
// failure (hidden-failures.tsv from run_hidden.ts) and (re)open it, and
// assign the target's owner best-effort (see assignOwner for why here).
// Skipped when PR_URL is set - the only hidden-wrapped failures that let
// the run reach PR creation are validation ones, and open_pr.ts already
// routed those into the PR body. resolve (fully successful run): close
// the issue if one is open; none existing is a no-op.
//
// The issue is found by exact title among issues created by the token's
// user, never by a marker label: the settings apply deletes undeclared
// labels, so a label would enter a delete/recreate loop. Both modes are
// best-effort - an API failure emits ONE ::warning and exits 0. The
// warning follows the reference implementation's rule: it names the HTTP
// status and generic advice only - never the slug, the request path, or
// the API's message, all of which would leak into this public log (the
// issue URL contains the slug, so it stays unprinted too).
//
// Usage: failure_issue.ts deliver|resolve
// Env: TARGET, GH_TOKEN, RUN_URL, RUNNER_TEMP, GITHUB_REPOSITORY;
// PR_URL (deliver only, may be empty).

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, requireEnv } from "../shared/gha.ts";

const mode = process.argv[2];
if (mode !== "deliver" && mode !== "resolve") {
  console.log("::error::failure_issue.ts: expected mode 'deliver' or 'resolve'");
  process.exit(2);
}
const target = requireEnv("TARGET");
const runUrl = requireEnv("RUN_URL");
const runnerTemp = requireEnv("RUNNER_TEMP");
const repository = requireEnv("GITHUB_REPOSITORY");

const ISSUE_TITLE = "[automated] repo-platform sync: private failure report";
// gh's stderr accumulates here, captured and never printed: it embeds the
// request path and API message.
let errlog = "";

function gh(
  args: string[],
  options: { stdoutToErrlog?: boolean } = {},
): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(["gh", ...args], {
    env: { ...process.env, ISSUE_TITLE },
    stdout: "pipe",
    stderr: "pipe",
  });
  errlog += proc.stderr.toString();
  const stdout = proc.stdout.toString();
  // The write calls fold stdout into the errlog too (the bash version's
  // `>>errlog 2>&1`): gh runs them with --silent but can still print an
  // HTTP status on failure. Reads keep stdout as the result.
  if (options.stdoutToErrlog) errlog += stdout;
  return { exitCode: proc.exitCode ?? 1, stdout };
}

// One warning, public-safe: only the bare HTTP status is lifted out of
// the captured stderr. A permission-shaped status gets the grant advice;
// no status at all means the request died before an HTTP response.
function warnAndExit(lead: string, tail: string): never {
  const statuses = errlog.match(/HTTP [0-9]{3}/g);
  let status = statuses?.[statuses.length - 1] ?? "";
  let advice: string;
  if (status === "HTTP 401" || status === "HTTP 403" || status === "HTTP 404") {
    advice =
      "Check that the REPO_PLATFORM_TOKEN grants Issues read/write on the target repository.";
  } else if (status === "") {
    status = "no HTTP response arrived";
    advice = "Re-run the sync if it persists.";
  } else {
    advice = "Re-run the sync if it persists.";
  }
  console.log(`::warning::${lead} (${status}). ${advice} ${tail}`);
  process.exit(0);
}
const deliverLead =
  "sync failure diagnostics could not be delivered to the target repository's failure-report issue";
const deliverTail =
  "This run's captured output dies with the runner; reproduce the failure locally per docs/private-repos.md.";
const resolveLead =
  "the target repository's failure-report issue could not be resolved after this healthy run";
const resolveTail = "If one is open, close it manually.";

// Returns "<number> <state> <assignee-count>" for the reused issue, ""
// when none exists, or null on an API failure. Filtering to the token
// user's own issues keeps a title squatted by someone else from hijacking
// the delivery; creation order makes the oldest issue win deterministically
// should a duplicate ever appear.
function findIssue(): string | null {
  const login = gh(["api", "user", "--jq", ".login"]);
  if (login.exitCode !== 0) return null;
  const list = gh([
    "api",
    `repos/${target}/issues`,
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    "-f",
    "state=all",
    "-f",
    `creator=${login.stdout.trimEnd()}`,
    "-f",
    "sort=created",
    "-f",
    "direction=asc",
    "-F",
    "per_page=100",
    "--jq",
    `[.[][] | select(has("pull_request") | not)
      | select(.title == env.ISSUE_TITLE)] | first
      | if . == null then ""
        else "\\(.number) \\(.state) \\(.assignees | length)" end`,
  ]);
  if (list.exitCode !== 0) return null;
  return list.stdout.replace(/\n$/, "");
}

// Assign the target's owner to the failure-report issue: an issue created
// with a workflow token fires no issues:opened event, so no automation on
// the target can catch it - assignment has to happen at creation, here.
// The owner login is the target slug's first segment (a personal-account
// fleet: a user repo's owner is assignable). Best-effort by constraint: an
// org-owned target's owner is an org and not assignable, and delivery must
// not gain a failure path over assignment, so a failure logs one
// public-safe notice (no login, no issue number: the target's owner is
// half the private slug) and the delivery stands.
function assignOwner(issueNumber: string): void {
  const owner = target.split("/")[0];
  // try/catch, not just the exit-code check: Bun.spawnSync itself can
  // throw (gh vanishing mid-run), and by this point the delivery already
  // succeeded - nothing about assignment may unwind that.
  let failed: boolean;
  try {
    const assign = gh(
      [
        "api",
        `repos/${target}/issues/${issueNumber}/assignees`,
        "--method",
        "POST",
        "--silent",
        "-f",
        `assignees[]=${owner}`,
      ],
      { stdoutToErrlog: true },
    );
    failed = assign.exitCode !== 0;
  } catch {
    failed = true;
  }
  if (failed) {
    console.log(
      "::notice::could not assign the repository owner to the failure-report issue (best-effort); the report delivery itself succeeded",
    );
  }
}

const bodyFile = join(runnerTemp, "failure-issue-body.md");
const EXCERPT_BYTES = 20000;

if (mode === "deliver") {
  if (env("PR_URL") !== "") {
    console.log("the sync PR carries this failure's hidden diagnostics; no issue delivery needed");
    process.exit(0);
  }
  const manifestFile = join(runnerTemp, "hidden-failures.tsv");
  if (!existsSync(manifestFile) || statSync(manifestFile).size === 0) {
    console.log("no hidden step failed; the public log already carries this failure's diagnosis");
    process.exit(0);
  }
  const manifest = readFileSync(manifestFile, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [label, rc, capture] = line.split("\t");
      return { label, rc, capture };
    });

  // The fence must outrun the longest backtick run in each SHIPPED
  // excerpt, or a captured line could terminate its own code block early
  // (a run split by the truncation cut only gets shorter, so scanning
  // the excerpt is sufficient). Runs past 100 backticks are collapsed to
  // exactly 100 on write, which caps the fence at 101 and keeps the body
  // bounded under GitHub's 64 KiB limit.
  const excerptOf = (capture: string): string =>
    readFileSync(capture).subarray(0, EXCERPT_BYTES).toString("utf-8");
  const collapseRuns = (text: string): string => text.replace(/`{100,}/g, "`".repeat(100));
  let fenceLen = 4;
  for (const { capture } of manifest) {
    if (!existsSync(capture)) continue;
    const runs = excerptOf(capture).match(/`+/g) ?? [];
    const longest = Math.min(
      runs.reduce((max, run) => Math.max(max, run.length), 0),
      100,
    );
    fenceLen = Math.max(fenceLen, longest + 1);
  }
  const fence = "`".repeat(fenceLen);

  const sections: string[] = [
    `The push sync from \`${repository}\` failed for this repository, and no sync PR exists to carry the hidden diagnostics, so the captured output lands here instead (this repo's issues are as private as the repo).`,
    "",
    `Run: ${runUrl}`,
  ];
  for (const { label, rc, capture } of manifest) {
    sections.push("", `## ${label}: exit ${rc}`, "", `${fence}text`);
    if (existsSync(capture)) {
      // GitHub caps issue bodies at 64 KiB; keep each capture bounded
      // like open_pr.ts's PR-body excerpt.
      sections.push(collapseRuns(excerptOf(capture)));
      if (statSync(capture).size > EXCERPT_BYTES) {
        sections.push("(truncated at 20000 bytes; reproduce locally for the rest)");
      }
    }
    sections.push(fence);
  }
  sections.push(
    "",
    `This issue is reused by every sync run: each delivery replaces the body (earlier reports stay in the edit history), open means the sync needs attention, and the next fully healthy run closes it. Local reproduction: https://github.com/${repository}/blob/main/docs/private-repos.md`,
  );
  writeFileSync(bodyFile, `${sections.join("\n")}\n`);

  const found = findIssue();
  if (found === null) warnAndExit(deliverLead, deliverTail);
  if (found === "") {
    // --jq .number replaces --silent: the create must yield the new number
    // (nothing but a bare integer, so nothing private) for the assignment
    // call, while a failure's response body still folds into the unprinted
    // errlog.
    const create = gh(
      [
        "api",
        `repos/${target}/issues`,
        "--method",
        "POST",
        "-f",
        `title=${ISSUE_TITLE}`,
        "-F",
        `body=@${bodyFile}`,
        "--jq",
        ".number",
      ],
      { stdoutToErrlog: true },
    );
    if (create.exitCode !== 0) warnAndExit(deliverLead, deliverTail);
    const issueNumber = create.stdout.trim();
    if (/^[0-9]+$/.test(issueNumber)) {
      assignOwner(issueNumber);
    } else {
      console.log(
        "::notice::the created failure-report issue's number could not be read; owner assignment skipped",
      );
    }
  } else {
    const [issueNumber, , assigneeCount] = found.split(" ");
    const update = gh(
      [
        "api",
        `repos/${target}/issues/${issueNumber}`,
        "--method",
        "PATCH",
        "--silent",
        "-f",
        "state=open",
        "-F",
        `body=@${bodyFile}`,
      ],
      { stdoutToErrlog: true },
    );
    if (update.exitCode !== 0) warnAndExit(deliverLead, deliverTail);
    // A reused issue predating creation-time assignment may still be
    // unassigned; pick it up here. An assigned one is left alone - the
    // owner may have deliberately handed it off.
    if (assigneeCount === "0") assignOwner(issueNumber);
  }
  console.log(
    "hidden failure diagnostics delivered to the target's failure-report issue (URL withheld: private repository)",
  );
  process.exit(0);
}

const found = findIssue();
if (found === null) warnAndExit(resolveLead, resolveTail);
if (found === "" || found.split(" ")[1] !== "open") {
  process.exit(0);
}
writeFileSync(
  bodyFile,
  `Healthy: the push sync from \`${repository}\` completed cleanly as of ${runUrl}. The last failure report is in this issue's edit history.\n`,
);
const close = gh(
  [
    "api",
    `repos/${target}/issues/${found.split(" ")[0]}`,
    "--method",
    "PATCH",
    "--silent",
    "-f",
    "state=closed",
    "-F",
    `body=@${bodyFile}`,
  ],
  { stdoutToErrlog: true },
);
if (close.exitCode !== 0) warnAndExit(resolveLead, resolveTail);
console.log("failure-report issue closed: the sync is healthy again");
