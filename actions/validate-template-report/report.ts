#!/usr/bin/env bun
// The validate-template job's reporting: one sticky PR comment plus the
// step summary, assembled from the validator's findings/advisories files
// and the freshness step's verdict. Ported line-for-line from the inline
// bash the fleet ci.yml template used to carry; the behaviour contract is
// pinned by tests/actions/validate_template_report.test.ts.
//
// The contract: INTEGRITY blocks (managed content changed out of band)
// while FRESHNESS only informs, and this script itself NEVER fails the
// job - the caller's LAST step re-raises the deferred integrity verdict,
// so the comment here is already posted when the gate goes red. One
// comment is kept per PR (found by MARKER) rather than one per push, a
// clean-and-fresh run leaves no new comment but clears a stale one, and
// every reporting failure degrades to a warning with the findings still
// in the job summary.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY, FINDINGS,
// ADVISORIES, FRESHNESS (the three markdown files), FRESHNESS_STATE,
// EVENT_NAME, PR_NUMBER, RUN_URL.

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { capture, env, requireEnv, warning } from "./runtime.ts";

const NETWORK_TIMEOUT_MS = 20_000;
/** The paginated comment listing fetches N sequential pages under ONE
 * deadline, so its budget is several single-call writes' worth. */
const PAGINATED_TIMEOUT_MS = NETWORK_TIMEOUT_MS * 4;

// Identifies our own comment across runs. Keep it stable: changing it
// strands every comment already posted under the old one.
const MARKER = "<!-- repo-platform:validate-template -->";

const findingsFile = requireEnv("FINDINGS");
const advisoriesFile = requireEnv("ADVISORIES");
const freshnessFile = requireEnv("FRESHNESS");
const freshnessState = env("FRESHNESS_STATE");
const eventName = requireEnv("EVENT_NAME");
const prNumber = env("PR_NUMBER");
const runUrl = requireEnv("RUN_URL");
const repository = requireEnv("GITHUB_REPOSITORY");
const summaryFile = requireEnv("GITHUB_STEP_SUMMARY");

/** Whether the file exists with any content ([ -s ] in the old bash). */
const hasContent = (path: string): boolean => existsSync(path) && statSync(path).size > 0;
/** A file's text with trailing newlines stripped ($(cat) in the old bash);
 *  the fallback stands in for a file that cannot be read. */
const readTrimmed = (path: string, fallback = ""): string => {
  try {
    return readFileSync(path, "utf8").replace(/\n+$/, "");
  } catch {
    return fallback;
  }
};

// An absent findings file means the validator never got far enough to
// write one, which is a setup failure, not a clean tree.
let integrity: string;
let blocking: boolean;
if (!existsSync(findingsFile)) {
  integrity = `#### Integrity\n\nThe validator exited before reporting. See the [run log](${runUrl}).`;
  blocking = true;
} else if (hasContent(findingsFile)) {
  integrity = `#### Integrity\n\n${readTrimmed(findingsFile)}\nManaged content changed outside a sync. Restore the file from git history, or run a recovery sync. This FAILS the check.`;
  blocking = true;
} else {
  integrity = "#### Integrity\n\nPassed - this repository matches the state it was stamped with.";
  blocking = false;
}

// Advisories never gate - they are the validator's own non-failing stream,
// and folding them into the integrity verdict would have a clean
// repository reading as blocked.
const advice = hasContent(advisoriesFile) ? `\n\n${readTrimmed(advisoriesFile)}` : "";

const freshness =
  freshnessState === "behind"
    ? readTrimmed(freshnessFile, "#### Freshness\n\nNot checked this run; see the run log for why.")
    : freshnessState === "fresh"
      ? "#### Freshness\n\nUp to date with the template branch."
      : "#### Freshness\n\nNot checked this run; see the run log for why.";

const body = `${MARKER}\n### Template check\n\n${integrity}${advice}\n\n${freshness}`;
appendFileSync(summaryFile, `${body}\n`);

// A comment is worth making only when something needs saying. A clean,
// fresh repository leaves no new comment - but it does clear one a
// previous run left behind.
const worthSaying = blocking || freshnessState === "behind" || advice !== "";

if (eventName !== "pull_request") process.exit(0);

// --paginate: on a long PR our marker comment sits past the first page,
// and a lookup that misses it POSTS A NEW ONE on every push. --slurp
// yields one array per page, so flatten before searching.
const listing = capture(
  [
    "gh",
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/issues/${prNumber}/comments?per_page=100`,
    "--jq",
    "add // [] | map(select(.body | contains(env.MARKER))) | last | .id // empty",
  ],
  { timeoutMs: PAGINATED_TIMEOUT_MS, env: { MARKER } },
);
if (listing.exitCode !== 0) {
  warning("could not list PR comments; the findings are in the job summary instead.");
  process.exit(0);
}
const existing = listing.stdout.trim();

if (!worthSaying && existing === "") process.exit(0);

if (existing !== "") {
  const patch = capture(
    [
      "gh",
      "api",
      "--method",
      "PATCH",
      `repos/${repository}/issues/comments/${existing}`,
      "-f",
      `body=${body}`,
      "--silent",
    ],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (patch.exitCode !== 0) {
    warning("could not update the findings comment; the findings are in the job summary instead.");
  }
} else {
  const post = capture(
    [
      "gh",
      "api",
      "--method",
      "POST",
      `repos/${repository}/issues/${prNumber}/comments`,
      "-f",
      `body=${body}`,
      "--silent",
    ],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (post.exitCode !== 0) {
    warning("could not post the findings comment; the findings are in the job summary instead.");
  }
}
