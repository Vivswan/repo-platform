#!/usr/bin/env bun
// Delivers one sync row's result into the target repository and nothing
// into the public log: a clean writer run becomes a commit on the rolling
// automation branch and a PR carrying the writer's report (auto-merge
// armed only when the report holds nothing and the run is not manual);
// a tree that already matches the build closes any open sync PR as
// obsolete; a failed checkout, writer, or push becomes one reused issue
// in the target carrying the log tails. Every line this script would say goes to
// $RUNNER_TEMP/deliver.log; the verdict for verdict.ts goes to
// $RUNNER_TEMP/verdict.txt, `failed` only once the issue is filed.
//
// Env: TARGET, TARGET_PRIVATE (GITHUB_ENV), PAT, GH_TOKEN, RUNNER_TEMP,
// BUILD, CHECKOUT_OUTCOME, WRITER_OUTCOME (the steps' outcomes), MANUAL,
// RUN_URL, GITHUB_REPOSITORY; TARGET_DIR (default target).

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, requireEnv } from "../shared/gha.ts";
import { SYNC_IDENTITY } from "../shared/git_identity.ts";
import { capture, type RunResult, redactText } from "../shared/proc.ts";
import { AUTOMATION_BRANCH } from "./automation_branch.ts";
import { type DeliveryVerdict, VERDICT_FILE } from "./verdict.ts";
import { REPLACED_HEADING, REVIEW_HEADING } from "./writer/report.ts";

export const FAILURE_ISSUE_TITLE = "[repo-platform] sync failed";
export const CHECKOUT_LOG = "checkout.log";
export const SYNC_LOG = "sync.log";
export const DELIVER_LOG = "deliver.log";
export const SUMMARY_FILE = "summary.json";
/** The bytes of each log a filed issue carries, from the end. */
export const TAIL_BYTES = 20_000;

export function prTitle(build: string): string {
  return `chore: sync repo-platform build ${build.slice(0, 12)}`;
}

/** The last `bytes` of a file, decoded, or "" when it is absent. */
export function tail(path: string, bytes = TAIL_BYTES): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const buffer = readFileSync(path);
  const cut = buffer.subarray(Math.max(0, size - bytes)).toString("utf-8");
  return size > bytes ? `... (${size - bytes} earlier bytes not shown)\n${cut}` : cut;
}

/** A code fence longer than any backtick run in `text`. */
export function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(4, longest + 1));
}

export function failureBody(input: {
  runUrl: string;
  build: string;
  reason: string;
  checkoutLog: string;
  syncLog: string;
  deliverLog: string;
}): string {
  const block = (title: string, text: string) => {
    if (text === "") return [];
    const fence = fenceFor(text);
    return ["", `## ${title}`, "", `${fence}text`, text.replace(/\n$/, ""), fence];
  };
  return [
    `The repo-platform sync for this repository failed: ${input.reason}.`,
    "",
    `Run: ${input.runUrl}`,
    `Build: \`${input.build}\``,
    ...block("Checkout log", input.checkoutLog),
    ...block("Writer log", input.syncLog),
    ...block("Delivery log", input.deliverLog),
    "",
    "This issue is reused by every sync run: each failure replaces the body (earlier reports stay in the edit history), and a run that delivers cleanly closes it.",
    "",
  ].join("\n");
}

/** GitHub refuses a PR body past 65,536 characters, and gh would fail
 *  after the branch is pushed; the report is cut under this. */
export const BODY_CAP = 60_000;
const CLOSING_FENCE = "\n```";

/** `text` cut to at most `budget` characters on a line boundary. */
export function truncatedLines(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf("\n", budget);
  return text.slice(0, cut <= 0 ? budget : cut);
}

/** `text` with a fence line appended when a cut left one open, so what
 *  follows renders as Markdown rather than as code. */
export function closedFences(text: string): string {
  const fences = text.split("\n").filter((line) => /^`{3,}/.test(line)).length;
  return fences % 2 === 0 ? text : `${text}${CLOSING_FENCE}`;
}

const cutMarker = (omitted: number) =>
  `\n\n> [!WARNING]\n> ${omitted} characters of this section were cut to fit GitHub's body limit.\n`;

/** `section` cut to fit `room`: its lines up to the room less the marker
 *  naming the omitted count, an open fence closed; "" when its heading
 *  line and the marker do not both fit. */
function cutSection(section: string, room: number): string {
  const headingEnd = section.indexOf("\n", 1);
  const heading = headingEnd === -1 ? section : section.slice(0, headingEnd);
  const reserve = cutMarker(section.length).length + CLOSING_FENCE.length;
  if (room < heading.length + reserve) return "";
  const kept = truncatedLines(section, room - reserve);
  return `${closedFences(kept)}${cutMarker(section.length - kept.length)}`;
}

/** The report's header (up to the first H3), then one part per H3. */
function sections(report: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let at = report.indexOf("\n### "); at !== -1; at = report.indexOf("\n### ", at + 1)) {
    parts.push(report.slice(start, at));
    start = at;
  }
  parts.push(report.slice(start));
  return parts;
}

/** The report cut to the body cap, section by section: the header and
 *  the Review section (the hold reasons) take their room first, then the
 *  tables and notes, then the replaced-edit diffs (a diff can carry lines
 *  of any length); a section the room runs out on is cut with a marker. */
export function boundedReport(report: string, cap = BODY_CAP): string {
  if (report.length <= cap) return report;
  const parts = sections(report);
  const rank = (index: number): number => {
    if (index === 0) return 0;
    if (parts[index].startsWith(`\n${REVIEW_HEADING}`)) return 1;
    return parts[index].startsWith(`\n${REPLACED_HEADING}`) ? 3 : 2;
  };
  const order = parts.map((_, index) => index).sort((a, b) => rank(a) - rank(b) || a - b);
  const kept = new Array<string>(parts.length);
  let room = cap;
  for (const index of order) {
    kept[index] = parts[index].length <= room ? parts[index] : cutSection(parts[index], room);
    room -= kept[index].length;
  }
  return kept.join("");
}

export function prBody(input: {
  operator: string;
  build: string;
  runUrl: string;
  report: string;
}): string {
  return [
    `Automated sync from [${input.operator}](https://github.com/${input.operator}) build \`${input.build}\` ([run](${input.runUrl})).`,
    "",
    boundedReport(input.report).replace(/\n$/, ""),
    "",
    "> [!NOTE]",
    "> This branch is regenerated on every sync run; commits pushed to it are overwritten.",
    "",
  ].join("\n");
}

/** `git <subcommand>` or `<program> <word>`: the log names the command, never its arguments. */
function commandLabel(argv: string[]): string {
  const words = argv[1] === "-C" ? [argv[0], ...argv.slice(3)] : argv;
  return words.slice(0, 2).join(" ");
}

/** One row's delivery: the env read once, every subprocess logged to the
 *  file, the verdict written last. */
class Delivery {
  readonly runnerTemp = requireEnv("RUNNER_TEMP");
  readonly target = requireEnv("TARGET");
  readonly targetDir = env("TARGET_DIR", "target");
  readonly build = requireEnv("BUILD");
  readonly runUrl = requireEnv("RUN_URL");
  readonly logFile = join(this.runnerTemp, DELIVER_LOG);

  constructor() {
    writeFileSync(this.logFile, "");
  }

  log(line: string): void {
    appendFileSync(this.logFile, `${redactText(line)}\n`);
  }

  verdict(value: DeliveryVerdict): void {
    writeFileSync(join(this.runnerTemp, VERDICT_FILE), `${value}\n`);
  }

  /** A subprocess whose streams land in the log, never on stdout. */
  run(argv: string[], label = commandLabel(argv), extraEnv?: Record<string, string>): RunResult {
    const result = capture(argv, extraEnv === undefined ? {} : { env: extraEnv });
    this.log(`$ ${label} -> exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
    if (result.stderr !== "") this.log(result.stderr.replace(/\n$/, ""));
    return result;
  }

  git(...args: string[]): string[] {
    return ["git", "-C", this.targetDir, ...args];
  }

  /** The token user's oldest issue with the failure title: number and
   *  state, "" when none, null when the lookup failed. */
  findFailureIssue(): { number: string; state: string } | "" | null {
    const login = this.run(["gh", "api", "user", "--jq", ".login"]);
    if (login.exitCode !== 0) return null;
    const list = this.run(
      [
        "gh",
        "api",
        `repos/${this.target}/issues`,
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "-f",
        "state=all",
        "-f",
        `creator=${login.stdout.trim()}`,
        "-f",
        "sort=created",
        "-f",
        "direction=asc",
        "-F",
        "per_page=100",
        "--jq",
        `[.[][] | select(has("pull_request") | not) | select(.title == env.ISSUE_TITLE)] | first | if . == null then "" else "\\(.number) \\(.state)" end`,
      ],
      "gh api issues GET",
      { ISSUE_TITLE: FAILURE_ISSUE_TITLE },
    );
    if (list.exitCode !== 0) return null;
    const found = list.stdout.trim();
    if (found === "") return "";
    const [number, state] = found.split(" ");
    return { number, state };
  }

  /** Files the failure issue; exits 1 when the target cannot take it. */
  fileFailure(reason: string): never {
    this.log(`filing the failure report: ${reason}`);
    const bodyFile = join(this.runnerTemp, "failure-issue-body.md");
    writeFileSync(
      bodyFile,
      failureBody({
        runUrl: this.runUrl,
        build: this.build,
        reason,
        checkoutLog: tail(join(this.runnerTemp, CHECKOUT_LOG)),
        syncLog: tail(join(this.runnerTemp, SYNC_LOG)),
        deliverLog: tail(this.logFile),
      }),
    );
    const found = this.findFailureIssue();
    if (found === null) process.exit(1);
    const write =
      found === ""
        ? this.run(
            [
              "gh",
              "api",
              `repos/${this.target}/issues`,
              "--method",
              "POST",
              "--silent",
              "-f",
              `title=${FAILURE_ISSUE_TITLE}`,
              "-F",
              `body=@${bodyFile}`,
            ],
            "gh api issues POST",
          )
        : this.run(
            [
              "gh",
              "api",
              `repos/${this.target}/issues/${found.number}`,
              "--method",
              "PATCH",
              "--silent",
              "-f",
              "state=open",
              "-F",
              `body=@${bodyFile}`,
            ],
            "gh api issues PATCH",
          );
    if (write.exitCode !== 0) process.exit(1);
    this.verdict("failed");
    process.exit(0);
  }

  /** Closes an open failure issue after a clean delivery; best-effort. */
  closeFailureIssue(): void {
    const found = this.findFailureIssue();
    if (found === null || found === "" || found.state !== "open") return;
    const bodyFile = join(this.runnerTemp, "failure-issue-close.md");
    writeFileSync(
      bodyFile,
      `Healthy again: the repo-platform sync delivered cleanly as of ${this.runUrl}. The last failure report is in this issue's edit history.\n`,
    );
    this.run(
      [
        "gh",
        "api",
        `repos/${this.target}/issues/${found.number}`,
        "--method",
        "PATCH",
        "--silent",
        "-f",
        "state=closed",
        "-F",
        `body=@${bodyFile}`,
      ],
      "gh api issues PATCH",
    );
  }

  openPr(): { number: string } | null {
    const list = this.run(
      [
        "gh",
        "pr",
        "list",
        "-R",
        this.target,
        "--head",
        AUTOMATION_BRANCH,
        "--state",
        "open",
        "--json",
        "number",
        "--jq",
        ".[0].number // empty",
      ],
      "gh pr list",
    );
    if (list.exitCode !== 0) this.fileFailure("listing the sync pull request failed");
    const number = list.stdout.trim();
    return number === "" ? null : { number };
  }

  /** Turns auto-merge off on the sync PR when it is on; a failed read or
   *  disarm files the failure, since an armed PR could merge on its own. */
  disarm(number: string): void {
    const armed = this.run(
      [
        "gh",
        "pr",
        "view",
        number,
        "-R",
        this.target,
        "--json",
        "autoMergeRequest",
        "--jq",
        ".autoMergeRequest != null",
      ],
      "gh pr view",
    );
    if (armed.exitCode !== 0)
      this.fileFailure("reading the sync pull request's auto-merge state failed");
    if (armed.stdout.trim() !== "true") return;
    const disarm = this.run(
      ["gh", "pr", "merge", number, "-R", this.target, "--disable-auto"],
      "gh pr merge --disable-auto",
    );
    if (disarm.exitCode !== 0)
      this.fileFailure("disarming the sync pull request's auto-merge failed");
  }

  /** A tree that already matches the build makes any open sync PR
   *  obsolete (a selection reverted on the default branch, say): it is
   *  disarmed, closed, and its branch deleted so stale files never merge. */
  closeObsoletePr(): void {
    const existing = this.openPr();
    if (existing === null) return;
    this.disarm(existing.number);
    const closed = this.run(
      [
        "gh",
        "pr",
        "close",
        existing.number,
        "-R",
        this.target,
        "--delete-branch",
        "--comment",
        `superseded: the target already matches build ${this.build}`,
      ],
      "gh pr close",
    );
    if (closed.exitCode !== 0) this.fileFailure("closing the obsolete sync pull request failed");
    this.log(`closed the obsolete sync pull request #${existing.number} and deleted its branch`);
  }

  deliver(): void {
    if (env("CHECKOUT_OUTCOME") !== "success") this.fileFailure("the target checkout failed");
    if (env("WRITER_OUTCOME") !== "success") this.fileFailure("the writer exited with an error");
    const summary = JSON.parse(readFileSync(join(this.runnerTemp, SUMMARY_FILE), "utf-8")) as {
      hold: boolean;
    };
    const report = readFileSync(join(this.runnerTemp, SYNC_LOG), "utf-8");

    for (const argv of [
      this.git("config", "user.name", SYNC_IDENTITY.name),
      this.git("config", "user.email", SYNC_IDENTITY.email),
      this.git("add", "--all"),
    ]) {
      if (this.run(argv).exitCode !== 0)
        this.fileFailure(`${commandLabel(argv)} failed in the target`);
    }
    const status = this.run(this.git("status", "--porcelain"));
    if (status.exitCode !== 0) this.fileFailure("reading the working tree status failed");
    if (status.stdout.trim() === "") {
      this.log("the tree already matches the build; nothing to deliver");
      this.closeObsoletePr();
      this.closeFailureIssue();
      this.verdict("unchanged");
      return;
    }
    const base = this.run(this.git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    if (base === "" || base === "HEAD") this.fileFailure("the target checkout is not on a branch");
    if (this.run(this.git("checkout", "-q", "-B", AUTOMATION_BRANCH)).exitCode !== 0) {
      this.fileFailure("creating the automation branch failed");
    }
    if (this.run(this.git("commit", "-q", "-m", prTitle(this.build))).exitCode !== 0) {
      this.fileFailure("committing the sync failed");
    }

    // An armed PR is disarmed before the branch moves: the incoming
    // revision may need review; re-arming below is the clean path's call.
    const existing = this.openPr();
    if (existing !== null) this.disarm(existing.number);

    // The checkout kept no credentials; the push alone authenticates, with
    // a lease on the branch's remote tip so a concurrent writer fails loudly.
    const pushUrl = `https://x-access-token:${requireEnv("PAT")}@github.com/${this.target}.git`;
    const lease = this.run(
      this.git("ls-remote", pushUrl, `refs/heads/${AUTOMATION_BRANCH}`),
      "git ls-remote",
    );
    if (lease.exitCode !== 0) this.fileFailure("reading the automation branch's remote tip failed");
    const tip = lease.stdout.trim().split("\t")[0] ?? "";
    const push = this.run(
      this.git(
        "push",
        "--quiet",
        `--force-with-lease=${AUTOMATION_BRANCH}:${tip}`,
        pushUrl,
        `HEAD:refs/heads/${AUTOMATION_BRANCH}`,
      ),
      "git push",
    );
    if (push.exitCode !== 0) this.fileFailure("pushing the automation branch failed");

    const bodyFile = join(this.runnerTemp, "pr-body.md");
    writeFileSync(
      bodyFile,
      prBody({
        operator: requireEnv("GITHUB_REPOSITORY"),
        build: this.build,
        runUrl: this.runUrl,
        report,
      }),
    );
    let number: string;
    let outcome: DeliveryVerdict;
    if (existing === null) {
      const created = this.run(
        [
          "gh",
          "pr",
          "create",
          "-R",
          this.target,
          "--base",
          base,
          "--head",
          AUTOMATION_BRANCH,
          "--title",
          prTitle(this.build),
          "--body-file",
          bodyFile,
        ],
        "gh pr create",
      );
      if (created.exitCode !== 0) this.fileFailure("creating the sync pull request failed");
      number = created.stdout.trim().split("/").pop() ?? "";
      outcome = "opened";
    } else {
      const edited = this.run(
        [
          "gh",
          "pr",
          "edit",
          existing.number,
          "-R",
          this.target,
          "--title",
          prTitle(this.build),
          "--body-file",
          bodyFile,
        ],
        "gh pr edit",
      );
      if (edited.exitCode !== 0) this.fileFailure("refreshing the sync pull request failed");
      number = existing.number;
      outcome = "refreshed";
    }
    if (summary.hold) {
      this.log("auto-merge left off: the report holds the PR for review");
    } else if (env("MANUAL") === "true") {
      this.log("auto-merge left off: manual run");
    } else if (number !== "") {
      // A refused arm (auto-merge disabled in the target) is the target's
      // choice: the PR waits for a human, and the log says so.
      this.run(
        ["gh", "pr", "merge", number, "-R", this.target, "--squash", "--auto"],
        "gh pr merge --auto",
      );
    }
    this.closeFailureIssue();
    this.verdict(outcome);
  }
}

if (import.meta.main) new Delivery().deliver();
