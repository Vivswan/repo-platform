#!/usr/bin/env bun
// The validate-template job's reporting: one sticky PR comment plus the
// step summary, assembled from the integrity leg's verdict, the latest
// validator's report pair, and the build-branch compare the fetch step
// made. The behaviour contract is pinned by
// tests/actions/validate_template_report.test.ts.
//
// The contract: INTEGRITY blocks (the verdict of the validator at the
// repository's own `_commit`; a run that produced no verdict is
// `not-judged` and blocks too), the LATEST pass only warns (rules the next
// sync brings), FRESHNESS only informs, and this script itself NEVER fails
// the job - the caller's LAST step re-raises the deferred integrity
// outcome, so the comment here is already posted when the gate goes red.
// One comment is kept per PR (found by MARKER) rather than one per push, a
// clean-and-fresh run leaves no new comment but clears a stale one, and
// every reporting failure degrades to a warning with the findings still in
// the job summary.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY, VERDICT (the
// integrity leg's verdict file), LATEST_FINDINGS, LATEST_ADVISORIES (the
// build tip validator's pair), COMPARE_STATUS and AHEAD_BY (the fetch
// step's compare outputs), EVENT_NAME, PR_NUMBER, RUN_URL.

import { appendFileSync, readFileSync, statSync } from "node:fs";
import { capture, env, requireEnv, warning } from "./runtime.ts";
import { readVerdict } from "./verdict.ts";

const NETWORK_TIMEOUT_MS = 20_000;
/** The paginated comment listing fetches N sequential pages under ONE
 * deadline, so its budget is several single-call writes' worth. */
const PAGINATED_TIMEOUT_MS = NETWORK_TIMEOUT_MS * 4;

// Identifies our own comment across runs. Keep it stable: changing it
// strands every comment already posted under the old one.
const MARKER = "<!-- repo-platform:validate-template -->";

const verdict = readVerdict(requireEnv("VERDICT"));
const latestFindingsFile = requireEnv("LATEST_FINDINGS");
const latestAdvisoriesFile = requireEnv("LATEST_ADVISORIES");
const compareStatus = env("COMPARE_STATUS");
const aheadBy = env("AHEAD_BY");
const eventName = requireEnv("EVENT_NAME");
const prNumber = env("PR_NUMBER");
const runUrl = requireEnv("RUN_URL");
const repository = requireEnv("GITHUB_REPOSITORY");
const summaryFile = requireEnv("GITHUB_STEP_SUMMARY");

/** A file's text with trailing newlines stripped, or null when there is
 *  no regular file at the path. */
const readReport = (path: string): string | null => {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8").replace(/\n+$/, "");
  } catch {
    return null;
  }
};

let integrity: string;
switch (verdict.kind) {
  case "clean":
    integrity = "#### Integrity\n\nPassed - this repository matches the state it was stamped with.";
    break;
  case "findings":
    integrity = `#### Integrity\n\n${verdict.findings}\nManaged content changed outside a sync. Restore the file from git history, or run a recovery sync. This FAILS the check.`;
    break;
  case "not-judged":
    integrity = `#### Integrity\n\nNot judged: ${verdict.reason}. See the [run log](${runUrl}). This FAILS the check.`;
    break;
}
const blocking = verdict.kind !== "clean";

// Advisories never gate - they are the validator's own non-failing stream,
// and folding them into the integrity verdict would have a clean
// repository reading as blocked.
const advisories = verdict.kind === "not-judged" ? "" : verdict.advisories;
const advice = advisories === "" ? "" : `\n\n${advisories}`;

/** The `- ` items of a report file (its headings carry only counts). */
const bullets = (text: string | null): string[] =>
  (text ?? "").split("\n").filter((line) => line.startsWith("- "));

// The build tip's validator applies the rules the next sync PR brings, so
// its findings are warnings, never a verdict, and anything the aligned
// validator already reported is not said twice. A latest pass that never
// wrote its findings is a setup failure worth a line, not silence.
const LATEST_HEADING = "#### After your next sync";
const alreadySaid = new Set([
  ...bullets(verdict.kind === "findings" ? verdict.findings : ""),
  ...bullets(advisories),
]);
const latestFindings = readReport(latestFindingsFile);
const upcoming = [...bullets(latestFindings), ...bullets(readReport(latestAdvisoriesFile))].filter(
  (line) => !alreadySaid.has(line),
);
const latest =
  latestFindings === null
    ? `\n\n${LATEST_HEADING}\n\nThe current template's validator exited before reporting. See the [run log](${runUrl}).`
    : upcoming.length > 0
      ? `\n\n${LATEST_HEADING}\n\nThe current template's validator also reports the following; the next sync PR brings these rules, and they do not fail this check.\n\n${upcoming.join("\n")}`
      : "";

// Freshness reads the fetch step's compare: `ahead` is the build branch
// ahead of the recorded commit, `identical` is up to date, and anything
// else (a diverged or unknown sha, a failed call, no call at all) is a run
// the integrity leg already refused, so the refusal is the reason.
let freshness: string;
let behind = false;
if (compareStatus === "identical") {
  freshness = "#### Freshness\n\nUp to date with the build branch.";
} else if (compareStatus === "ahead") {
  const distance = /^[0-9]+$/.test(aheadBy) ? ` by ${aheadBy} commit(s)` : "";
  freshness = `#### Freshness\n\nThis repository is behind the build branch${distance}. The next sync PR updates the managed files; nothing to do here.`;
  behind = true;
} else {
  const reason =
    verdict.kind === "not-judged"
      ? verdict.reason
      : `the build branch compare reported \`${compareStatus || "nothing"}\``;
  freshness = `#### Freshness\n\nNot checked this run: ${reason}.`;
}

const body = `${MARKER}\n### Template check\n\n${integrity}${advice}${latest}\n\n${freshness}`;
appendFileSync(summaryFile, `${body}\n`);

// A comment is worth making only when something needs saying. A clean,
// fresh repository leaves no new comment - but it does clear one a
// previous run left behind.
const worthSaying = blocking || behind || advice !== "" || latest !== "";

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
