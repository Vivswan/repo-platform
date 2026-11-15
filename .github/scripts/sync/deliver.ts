#!/usr/bin/env bun
// Nothing this script says reaches the public log: every line goes to $RUNNER_TEMP/deliver.log, and the verdict verdict.ts reads
// goes to $RUNNER_TEMP/verdict.txt, `failed` only once the issue is filed. The one exception is a branch delivery's report,
// written to the public job summary for a public target and withheld for a private one.
//
// GitHub is asked through the scripts' client. Auto-merge alone stays on `gh pr merge`: gh merges a pull request that is
// already mergeable and arms the rest, a choice no single API call makes.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summary } from "@actions/core";
import MarkdownIt from "markdown-it";
import { z } from "zod";
import {
  AUTOMATION_BRANCH,
  FAILURE_ISSUE_TITLE,
  MANIFEST_NAME,
  PLATFORM_NAME,
  REGISTRATION_PATH,
  SYNC_PR_TITLE_PREFIX,
} from "../../../actions/shared/platform.ts";
import { NETWORK_TIMEOUT_MS, readDispatchBranch } from "../fleet/discovery.ts";
import { env, requireEnv } from "../shared/gha.ts";
import { SYNC_IDENTITY } from "../shared/git_identity.ts";
import {
  type Fields,
  GitHubClient,
  type Read,
  type Sent,
  unansweredReason,
  type WriteMethod,
} from "../shared/github.ts";
import { parseJsonWithThrow } from "../shared/json.ts";
import { fenced } from "../shared/markdown_code.ts";
import { capture, redactText } from "../shared/proc.ts";
import { tokenUrl } from "../shared/token_url.ts";
import { readMigrated } from "./migrate.ts";
import { type DeliveryVerdict, VERDICT_FILE } from "./verdict.ts";
import { REPLACED_HEADING, REVIEW_HEADING, type SyncReport, syncReport } from "./writer/report.ts";

/** The checkout step's log in RUNNER_TEMP, tailed into the failure issue. */
export const CHECKOUT_LOG = "checkout.log";

/** The writer's report in RUNNER_TEMP: the PR body's source, and tailed into the failure issue. */
export const SYNC_LOG = "sync.log";

/** This step's own call log in RUNNER_TEMP, tailed into the failure issue. */
export const DELIVER_LOG = "deliver.log";

/** The writer's SyncReport as JSON, in RUNNER_TEMP. */
export const SUMMARY_FILE = "summary.json";

/** How much of each log's end the failure issue quotes. */
export const TAIL_BYTES = 20_000;

/** Every subprocess here is one gh call, one git network call, or one local git call on the clone, each answering in seconds, so the fleet's stalled-network bound applies. */
export const DELIVERY_CALL_BOUND_MS = NETWORK_TIMEOUT_MS;

/** The token's own account, which files the failure issue. */
const account = z.object({ login: z.string() });

/** One row of the issues listing, which lists pull requests too: only those carry `pull_request`. */
const listedIssue = z.object({
  number: z.number(),
  state: z.string(),
  title: z.string(),
  pull_request: z.unknown().optional(),
});

/** One row of the pulls listing. `auto_merge` is required: a listing without it must not read as "not armed". */
const listedPull = z.object({
  number: z.number(),
  auto_merge: z.looseObject({}).nullable(),
  // The head repository is null once a fork is deleted.
  head: z.object({ ref: z.string(), repo: z.object({ id: z.number() }).nullable() }),
  base: z.object({ repo: z.object({ id: z.number() }) }),
});

/** The pull request a create answers with. */
const createdPull = z.object({ number: z.number() });

export function prTitle(build: string): string {
  return `${SYNC_PR_TITLE_PREFIX} ${build.slice(0, 12)}`;
}

/** The last `bytes` of the file at `path` as text, behind a line saying how much came before; empty for no file. */
export function tail(path: string, bytes = TAIL_BYTES): string {
  if (!existsSync(path)) return "";
  const buffer = readFileSync(path);
  if (buffer.length <= bytes) return buffer.toString("utf-8");

  // A cut inside a multi-byte character would open the quote with U+FFFD: UTF-8 continuation bytes are 10xxxxxx.
  let start = buffer.length - bytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;

  return `... (${start} earlier bytes not shown)\n${buffer.subarray(start).toString("utf-8")}`;
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
    return ["", `## ${title}`, "", ...fenced(text.replace(/\n$/, ""), "text")];
  };
  return [
    `The ${PLATFORM_NAME} sync for this repository failed: ${input.reason}.`,
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

/** GitHub refuses a PR body past 65,536 characters, and the refusal would come after the branch is pushed; the report is cut under this. */
export const BODY_CAP = 60_000;

export function truncatedLines(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf("\n", budget);
  return text.slice(0, cut <= 0 ? budget : cut);
}

/** The parser the body cut reads fences through; `html` so a details block is its own token, not paragraph text. */
const markdown = new MarkdownIt({ html: true });

/** Lines as markdown-it counts them: a final newline ends a line and starts none. */
const lineCount = (text: string): number =>
  text.split("\n").length - (text === "" || text.endsWith("\n") ? 1 : 0);

/** markdown-it gives a fence no "closed" flag: its `map` span counts the closing line when there is one and its
 *  `content` never does, so an unclosed fence is the one whose span holds only the opener and the content. */
function fences(text: string): { markup: string; closed: boolean }[] {
  const found: { markup: string; closed: boolean }[] = [];
  for (const token of markdown.parse(text, {})) {
    if (token.type !== "fence" || token.map === null) continue;
    const [start, end] = token.map;
    found.push({ markup: token.markup, closed: end - start === lineCount(token.content) + 2 });
  }
  return found;
}

/** A cut can leave a fence open, and everything after it would then render as code. */
export function closedFences(text: string): string {
  const last = fences(text).at(-1);
  return last === undefined || last.closed ? text : `${text}\n${last.markup}`;
}

const cutMarker = (omitted: number) =>
  `\n\n> [!WARNING]\n> ${omitted} characters of this section were cut to fit GitHub's body limit.\n`;

function cutSection(section: string, room: number): string {
  const headingEnd = section.indexOf("\n", 1);
  const heading = headingEnd === -1 ? section : section.slice(0, headingEnd);
  const longest = fences(section).reduce((max, fence) => Math.max(max, fence.markup.length), 0);
  const reserve = cutMarker(section.length).length + (longest === 0 ? 0 : longest + 1);
  if (room < heading.length + reserve) return "";
  const kept = truncatedLines(section, room - reserve);
  return `${closedFences(kept)}${cutMarker(section.length - kept.length)}`;
}

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

/** Section by section, the Review section (the hold reasons) takes its room right after the header and the replaced-edit diffs last:
 *  a diff can carry lines of any length. */
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

/** The add_modules line names the dispatch's value: the reviewer's first question is why the registration moved, or why it did not. */
export function prBody(input: {
  operator: string;
  build: string;
  runUrl: string;
  report: string;
  addModules: string;
  registrationChanged: boolean;
}): string {
  const dispatched = `Dispatched with \`add_modules=${input.addModules}\``;
  return [
    `Automated sync from [${input.operator}](https://github.com/${input.operator}) build \`${input.build}\` ([run](${input.runUrl})).`,
    "",
    ...(input.addModules === ""
      ? []
      : [
          input.registrationChanged
            ? `${dispatched}: \`${REGISTRATION_PATH}\` now selects them, and auto-merge stays off so the selection is reviewed.`
            : `${dispatched}: every name was already selected, so \`${REGISTRATION_PATH}\` is unchanged. Auto-merge stays off as on every add_modules run.`,
          "",
        ]),
    boundedReport(input.report).replace(/\n$/, ""),
    "",
    "> [!NOTE]",
    "> This branch is regenerated on every sync run; commits pushed to it are overwritten.",
    "",
  ].join("\n");
}

/** The job summary is as public as the run, so a private target's report and branch stay in the target: the commit is the
 *  record. It spells no repository, not even in a run link: the resolve step registered the target's name with the masker,
 *  which Actions applies to the summary too, so a spelled name renders as `***` (the operator's own, on a self-sync). */
export function branchSummary(input: {
  private: boolean;
  branch: string;
  build: string;
  report: string;
}): string {
  if (input.private) {
    return `Build \`${input.build}\` pushed onto the dispatched branch. The report is withheld: the repository is private, and the commit on the branch is the record.\n`;
  }
  return [
    `Build \`${input.build}\` pushed onto \`${input.branch}\`.`,
    "",
    boundedReport(input.report).replace(/\n$/, ""),
    "",
  ].join("\n");
}

/** By name and forced: a path the target's own .gitignore covers must reach the commit whose manifest names it
 *  (`git add --all` skipped it and shipped the manifest entry without the file). Literal, so a path spelling `[`, `*`
 *  or `?` stages itself alone. Renames off, so a retired path is listed as its own deletion. `before` holds the paths
 *  the steps ahead of the writer wrote: the rungs', and the registration on an add_modules run. */
export function stageWritten(
  summary: SyncReport,
  before: string[],
  git: (...args: string[]) => string[],
  must: (argv: string[], reason: string) => string,
): string[] {
  const changed = [
    MANIFEST_NAME,
    ...before,
    ...summary.written
      .filter((row) => row.change !== "unchanged" && row.change !== "held")
      .map((row) => row.path),
    ...summary.retired
      .filter((row) => row.outcome === "deleted" || row.outcome === "region removed")
      .map((row) => row.path),
    ...summary.mirrors.filter((row) => row.outcome !== "current").map((row) => row.target),
  ];
  must(
    git("add", "-f", "--", ...changed.map((path) => `:(literal)${path}`)),
    "staging the written paths failed in the checkout",
  );
  return must(
    git("diff", "--cached", "--name-only", "-z", "--no-renames"),
    "reading the staged paths failed in the checkout",
  )
    .split("\0")
    .filter((path) => path !== "");
}

/** `git <subcommand>` or `<program> <word>`: the log names the command, never its arguments. */
function commandLabel(argv: string[]): string {
  const words = argv[1] === "-C" ? [argv[0], ...argv.slice(3)] : argv;
  return words.slice(0, 2).join(" ");
}

/** stdout exists only on exit 0 (a deadline expiry never is, proc.ts): an errored call has no answer to misread. */
type Call = { ok: true; stdout: string } | { ok: false };

/** The target's open sync pull request. */
interface SyncPull {
  /** Its number in the target. */
  number: number;

  /** Auto-merge is on: it could merge on its own. */
  armed: boolean;
}

/** The target's failure issue, `none` when it has none, `unreadable` when GitHub did not say. */
type FailureIssue = { number: number; state: string } | "none" | "unreadable";

/** A delivery step failed: the entry point files `reason` as the target's failure issue. */
class DeliveryFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function failDelivery(reason: string): never {
  throw new DeliveryFailed(reason);
}

class Delivery {
  /** The run's scratch directory: the writer's summary and logs. */
  readonly runnerTemp = requireEnv("RUNNER_TEMP");

  /** The owner/name slug the sync delivers to. */
  readonly target = requireEnv("TARGET");

  /** The clone, relative to the workspace. */
  readonly targetDir = env("TARGET_DIR", "target");

  /** The platform commit delivered, a full sha. */
  readonly build = requireEnv("BUILD");

  /** This run's page, linked from the PR body and the failure issue. */
  readonly runUrl = requireEnv("RUN_URL");

  /** docs/platform/sync/operator.md, "Syncing a branch". */
  readonly branch = readDispatchBranch();

  /** The plan's admitted names, comma-joined (docs/platform/sync/operator.md, "Adding modules"). */
  readonly addModules = env("ADD_MODULES");

  /** This step's call log, tailed into the failure issue. */
  readonly logFile = join(this.runnerTemp, DELIVER_LOG);

  /** The API under the fleet token. */
  readonly github = new GitHubClient();

  /** The log starts empty, so every line it quotes is this run's. */
  constructor() {
    writeFileSync(this.logFile, "");
  }

  /** One line to the delivery log, redacted as the failure issue will quote it. */
  log(line: string): void {
    appendFileSync(this.logFile, `${redactText(line)}\n`);
  }

  /** The row's outcome, which the plan reads after the step. */
  verdict(value: DeliveryVerdict): void {
    writeFileSync(join(this.runnerTemp, VERDICT_FILE), `${value}\n`);
  }

  /** One bounded call, logged under its label; a failure logs its stderr and yields no stdout. */
  run(argv: string[], label = commandLabel(argv)): Call {
    const result = capture(argv, { timeoutMs: DELIVERY_CALL_BOUND_MS });
    this.log(`$ ${label} -> exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
    if (result.stderr !== "") this.log(result.stderr.replace(/\n$/, ""));
    return result.exitCode === 0 ? { ok: true, stdout: result.stdout } : { ok: false };
  }

  /** A git argv against the clone. */
  git(...args: string[]): string[] {
    return ["git", "-C", this.targetDir, ...args];
  }

  /** A failed call fails the delivery with `reason`; the stdout otherwise. */
  must(argv: string[], reason: string, label = commandLabel(argv)): string {
    const call = this.run(argv, label);
    if (!call.ok) failDelivery(reason);
    return call.stdout;
  }

  /** One API answer, logged as the call's method and its path under the target, with its status and never its text. */
  async answered<A extends Read<unknown> | Sent<unknown>>(
    call: string,
    pending: Promise<A>,
  ): Promise<A> {
    const answer = await pending;
    this.log(`$ ${call} -> ${answer.kind === "ok" ? "ok" : unansweredReason(answer)}`);
    return answer;
  }

  /** One write under the target's `repos/<owner>/<name>/`, its reply validated when the caller reads it. */
  send(method: WriteMethod, path: string, fields?: Fields): Promise<Sent<undefined>>;

  send<T>(method: WriteMethod, path: string, fields: Fields, reply: z.ZodType<T>): Promise<Sent<T>>;

  send<T>(
    method: WriteMethod,
    path: string,
    fields: Fields = {},
    reply?: z.ZodType<T>,
  ): Promise<Sent<T | undefined>> {
    const target = `repos/${this.target}/${path}`;
    const sent: Promise<Sent<T | undefined>> =
      reply === undefined
        ? this.github.send(method, target, fields)
        : this.github.send(method, target, fields, reply);
    return this.answered(`${method} ${path}`, sent);
  }

  /** A write that must land: anything but `ok` fails the delivery with `reason`. */
  async mustSend(method: WriteMethod, path: string, fields: Fields, reason: string): Promise<void> {
    const sent = await this.send(method, path, fields);
    if (sent.kind !== "ok") failDelivery(reason);
  }

  /** An open report outranks an older closed one: it is the one being watched, so a clean run closes it and a failure refreshes it. */
  async findFailureIssue(): Promise<FailureIssue> {
    const self = await this.answered("GET user", this.github.get("user", account));
    if (self.kind !== "ok") return "unreadable";

    // Created-ascending, so the first report across the pages is the oldest.
    const listed = await this.answered(
      "GET issues",
      this.github.paginate(`repos/${this.target}/issues`, listedIssue, {
        state: "all",
        creator: self.value.login,
        sort: "created",
        direction: "asc",
      }),
    );
    if (listed.kind !== "ok") return "unreadable";

    const reports = listed.value.filter(
      (issue) => issue.pull_request === undefined && issue.title === FAILURE_ISSUE_TITLE,
    );
    return reports.find((report) => report.state === "open") ?? reports[0] ?? "none";
  }

  /** Files or refreshes the failure issue, writes the failed verdict, and exits 0: the row failed, not the plan. */
  async fileFailure(reason: string): Promise<never> {
    this.log(`filing the failure report: ${reason}`);
    const body = failureBody({
      runUrl: this.runUrl,
      build: this.build,
      reason,
      checkoutLog: tail(join(this.runnerTemp, CHECKOUT_LOG)),
      syncLog: tail(join(this.runnerTemp, SYNC_LOG)),
      deliverLog: tail(this.logFile),
    });
    const found = await this.findFailureIssue();
    if (found === "unreadable") process.exit(1);

    const write =
      found === "none"
        ? await this.send("POST", "issues", { title: FAILURE_ISSUE_TITLE, body })
        : await this.send("PATCH", `issues/${found.number}`, { state: "open", body });
    if (write.kind !== "ok") process.exit(1);

    this.verdict("failed");
    process.exit(0);
  }

  /** The open failure issue, if there is one, is closed with a healthy-again note. */
  async closeFailureIssue(): Promise<void> {
    const found = await this.findFailureIssue();
    if (found === "unreadable" || found === "none" || found.state !== "open") return;

    await this.send("PATCH", `issues/${found.number}`, {
      state: "closed",
      body: `Healthy again: the ${PLATFORM_NAME} sync delivered cleanly as of ${this.runUrl}. The last failure report is in this issue's edit history.\n`,
    });
  }

  /** The listing's `head` filter matches by owner and branch, and GitHub ignores one it cannot read, so each row is
   *  checked here: the automation branch of the target itself, never a fork's branch of the same name. */
  async openPr(): Promise<SyncPull | null> {
    const [owner] = this.target.split("/");
    const listed = await this.answered(
      "GET pulls",
      this.github.paginate(`repos/${this.target}/pulls`, listedPull, {
        state: "open",
        head: `${owner}:${AUTOMATION_BRANCH}`,
      }),
    );
    if (listed.kind !== "ok") failDelivery("listing the sync pull request failed");

    const own = listed.value.find(
      (pull) => pull.head.ref === AUTOMATION_BRANCH && pull.head.repo?.id === pull.base.repo.id,
    );
    return own === undefined ? null : { number: own.number, armed: own.auto_merge !== null };
  }

  /** A failed disarm fails the delivery: an armed PR could merge on its own. */
  disarm(pull: SyncPull): void {
    if (!pull.armed) return;

    this.must(
      ["gh", "pr", "merge", String(pull.number), "-R", this.target, "--disable-auto"],
      "disarming the sync pull request's auto-merge failed",
      "gh pr merge --disable-auto",
    );
  }

  /** A selection reverted on the default branch, say, leaves the open sync PR carrying stale files that must never merge. */
  async closeObsoletePr(): Promise<void> {
    const existing = await this.openPr();
    if (existing === null) return;

    this.disarm(existing);
    const reason = "closing the obsolete sync pull request failed";
    await this.mustSend(
      "POST",
      `issues/${existing.number}/comments`,
      { body: `superseded: the target already matches build ${this.build}` },
      reason,
    );
    await this.mustSend("PATCH", `pulls/${existing.number}`, { state: "closed" }, reason);
    await this.mustSend("DELETE", `git/refs/heads/${AUTOMATION_BRANCH}`, {}, reason);

    this.log(`closed the obsolete sync pull request #${existing.number} and deleted its branch`);
  }

  /** The sync PR opened, or the open one refreshed onto the pushed branch. */
  async openOrRefreshPr(
    existing: SyncPull | null,
    base: string,
    body: string,
  ): Promise<{ number: number; outcome: DeliveryVerdict }> {
    const title = prTitle(this.build);
    if (existing === null) {
      const created = await this.send(
        "POST",
        "pulls",
        { title, head: AUTOMATION_BRANCH, base, body },
        createdPull,
      );
      if (created.kind !== "ok") failDelivery("creating the sync pull request failed");

      return { number: created.value.number, outcome: "opened" };
    }

    // The base follows the checkout: the default branch may have been renamed while the PR was open.
    await this.mustSend(
      "PATCH",
      `pulls/${existing.number}`,
      { title, base, body },
      "refreshing the sync pull request failed",
    );
    return { number: existing.number, outcome: "refreshed" };
  }

  /** Why auto-merge stays off for this run, null when it is armed. */
  autoMergeHeld(summary: SyncReport): string | null {
    if (summary.hold) return "the report holds the PR for review";
    if (env("MANUAL") === "true") return "manual run";
    if (this.addModules !== "") return "the run adds modules to the registration";

    return null;
  }

  /** A refused arm (auto-merge disabled in the target) is the target's choice: the PR waits for a human, and the log says so. */
  armAutoMerge(summary: SyncReport, number: number): void {
    const held = this.autoMergeHeld(summary);
    if (held !== null) {
      this.log(`auto-merge left off: ${held}`);
      return;
    }

    this.run(
      ["gh", "pr", "merge", String(number), "-R", this.target, "--squash", "--auto"],
      "gh pr merge --auto",
    );
  }

  /** The writer's summary; one that is not a sync report fails the delivery, its diagnosis in the delivery log. */
  readSummary(): SyncReport {
    const text = readFileSync(join(this.runnerTemp, SUMMARY_FILE), "utf-8");
    try {
      return parseJsonWithThrow(syncReport, text, SUMMARY_FILE);
    } catch (error) {
      this.log(error instanceof Error ? error.message : String(error));
      failDelivery("the writer's summary is not a sync report");
    }
  }

  /** The sync end to end: nothing staged ends it unchanged, a dispatched branch gets one commit, the default branch a PR. */
  async deliver(): Promise<void> {
    if (env("CHECKOUT_OUTCOME") !== "success") failDelivery("the target checkout failed");
    if (env("WRITER_OUTCOME") !== "success") failDelivery("the writer exited with an error");
    const summary = this.readSummary();
    const report = readFileSync(join(this.runnerTemp, SYNC_LOG), "utf-8");

    for (const argv of [
      this.git("config", "user.name", SYNC_IDENTITY.name),
      this.git("config", "user.email", SYNC_IDENTITY.email),
    ]) {
      this.must(argv, `${commandLabel(argv)} failed in the target`);
    }
    const staged = stageWritten(
      summary,
      [...readMigrated(this.runnerTemp), ...(this.addModules === "" ? [] : [REGISTRATION_PATH])],
      (...args) => this.git(...args),
      (argv, reason) => this.must(argv, reason),
    );
    if (staged.length === 0) {
      this.log("the tree already matches the build; nothing to deliver");
      if (this.branch === "") {
        await this.closeObsoletePr();
        await this.closeFailureIssue();
      }
      this.verdict("unchanged");
      return;
    }
    // symbolic-ref reads HEAD's target by name; `rev-parse --abbrev-ref HEAD` abbreviates through ref lookup, so a tag named
    // main answers heads/main and one named HEAD answers nothing.
    const head = this.must(
      this.git("symbolic-ref", "HEAD"),
      "git symbolic-ref failed in the target",
    ).trim();
    if (!head.startsWith("refs/heads/")) failDelivery("the target checkout is not on a branch");
    const base = head.slice("refs/heads/".length);
    if (this.branch !== "") {
      await this.deliverOntoBranch(report);
      return;
    }
    this.must(
      this.git("checkout", "-q", "-B", AUTOMATION_BRANCH),
      "creating the automation branch failed",
    );
    this.must(this.git("commit", "-q", "-m", prTitle(this.build)), "committing the sync failed");

    // An armed PR is disarmed before the branch moves: the incoming
    // revision may need review; re-arming below is the clean path's call.
    const existing = await this.openPr();
    if (existing !== null) this.disarm(existing);

    // The lease is the branch's remote tip, so a concurrent writer fails loudly.
    const lease = this.must(
      this.git("ls-remote", this.authUrl(), `refs/heads/${AUTOMATION_BRANCH}`),
      "reading the automation branch's remote tip failed",
      "git ls-remote",
    );
    this.push(AUTOMATION_BRANCH, lease.trim().split("\t")[0] ?? "", "the automation branch");

    const body = prBody({
      operator: requireEnv("GITHUB_REPOSITORY"),
      build: this.build,
      runUrl: this.runUrl,
      report,
      addModules: this.addModules,
      registrationChanged: staged.includes(REGISTRATION_PATH),
    });
    const { number, outcome } = await this.openOrRefreshPr(existing, base, body);
    this.armAutoMerge(summary, number);
    await this.closeFailureIssue();
    this.verdict(outcome);
  }

  /** The clone kept no credentials: the lease read and the push authenticate with this URL alone. */
  authUrl(): string {
    return tokenUrl(this.target, requireEnv("PAT"));
  }

  /** A lease-guarded force push through the credentialed URL. */
  push(branch: string, lease: string, what: string): void {
    this.must(
      this.git(
        "push",
        "--quiet",
        `--force-with-lease=${branch}:${lease}`,
        this.authUrl(),
        `HEAD:refs/heads/${branch}`,
      ),
      `pushing ${what} failed`,
      "git push",
    );
  }

  /** One commit onto the dispatched branch, no PR and no issue: the failure issue is the default-branch sync's, and the branch's own PR carries this commit. The lease is the commit the row cloned, so a commit pushed meanwhile fails the push. */
  async deliverOntoBranch(report: string): Promise<void> {
    const tip = this.must(
      this.git("rev-parse", "HEAD"),
      "reading the checkout's commit failed",
    ).trim();
    this.must(this.git("commit", "-q", "-m", prTitle(this.build)), "committing the sync failed");
    this.push(this.branch, tip, "the branch");
    await summary
      .addRaw(
        branchSummary({
          private: env("TARGET_PRIVATE") === "true",
          branch: this.branch,
          build: this.build,
          report,
        }),
      )
      .write();
    this.verdict("pushed");
  }

  /** The delivery, and the failure issue when a step of it failed. */
  async deliverOrReport(): Promise<void> {
    try {
      await this.deliver();
    } catch (error) {
      if (!(error instanceof DeliveryFailed)) throw error;

      await this.fileFailure(error.reason);
    }
  }
}

if (import.meta.main) await new Delivery().deliverOrReport();
