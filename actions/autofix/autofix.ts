// A pull request's fix, built by a job with no write token and pushed by one that runs no pull request code.
//
//   plan    -> does this event start a fix?                        (label: yes; push: only when a changed file matches `on`)
//   stage   -> after the repository's hook: stage what the lists allow, write the patch and a report
//   read    -> hand the report's subject to the caller, for the commit-names gate to judge
//   push    -> judge the patch again, commit it on the built sha, push leased to that sha, word the notice
//   unlabel -> take the one-shot label off
//   fork    -> take the label off a fork's pull request and say why nothing was fixed
//
// The push job trusts nothing the stage job hands over: it reads the event and the lists itself, and judges every path.

import { lstatSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { z } from "zod";
import {
  capture,
  env,
  failureDetail,
  messageOf,
  type RunOptions,
  type RunResult,
  requireEnv,
  succeeded,
} from "../shared/action_runtime.ts";
import {
  displacedBy,
  FORK_NOTICE,
  type NamedPath,
  noticeOf,
  type Outcome,
  quoted,
  quotedFailure,
  type Remarks,
} from "./notice.ts";
import {
  type FixEvent,
  judge,
  type Lists,
  matches,
  parseRawDiff,
  type RawChange,
  type Rejection,
  rejection,
} from "./paths.ts";

const LABEL = "fix-lint";
const DEFAULT_SUBJECT = "style: apply automated fixes";
const SUBJECT_MAX = 100;
const ONE_PRINTABLE_LINE = /^[\x20-\x7e]+$/;
const DEPENDABOT = "dependabot[bot]";
const DEPENDABOT_SKIP = "[dependabot skip]";
const BOT = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
} as const;
const PATCH_FILE = "fix.patch";
const REPORT_FILE = "report.json";
const REPORT_MAX_BYTES = 8_000_000;
const REPORT_CAPS = { subject: 1000, findings: 20_000, paths: 1000, path: 4096 } as const;
const LISTED_FILES_MAX = 3000;
const GIT_BOUND_MS = 120_000;
const PUSH_BOUND_MS = 300_000;
const API_BOUND_MS = 120_000;
const WARNED_PATHS = 10;
const GIT_SHA = /^[0-9a-f]{40}$/;
const LOCKED_GIT: readonly [string, string][] = [
  ["core.hooksPath", "/dev/null"],
  ["commit.gpgsign", "false"],
];

const listsSchema = z.strictObject({ paths: z.array(z.string()), delete: z.array(z.string()) });

const configSchema = z.strictObject({
  label: listsSchema,
  push: listsSchema.extend({ on: z.array(z.string()) }).nullable(),
});

const eventSchema = z.object({
  action: z.string(),
  label: z.object({ name: z.string() }).optional(),
  pull_request: z.object({
    number: z.number().int().positive(),
    changed_files: z.number().int().optional(),
    head: z.object({ sha: z.string().regex(GIT_SHA), ref: z.string().min(1) }),
    user: z.object({ login: z.string() }),
  }),
});

const reportedPath = z.string().max(REPORT_CAPS.path);

const droppedSchema = z.strictObject({ path: reportedPath, without: reportedPath.nullable() });

const reportSchema = z.strictObject({
  subject: z.string().max(REPORT_CAPS.subject),
  findings: z.string().max(REPORT_CAPS.findings),
  dropped: z.array(droppedSchema).max(REPORT_CAPS.paths),
  refused: z.array(reportedPath).max(REPORT_CAPS.paths),
});

/** Runs one child with a deadline and returns its exit and output; a test hands in a recorder. */
export type Runner = (command: string[], options: RunOptions) => RunResult;

/** The run's log, @actions/core's own in main; a test hands in a recorder. */
export type Log = Pick<typeof core, "info" | "warning">;

/** What a phase reaches the outside world through. */
export interface Tools {
  /** Runs git and gh. */
  run: Runner;

  /** Takes the run's annotations. */
  log: Log;
}

/** The registration's `autofix` block, as the plan action hands it over. */
export type Config = z.infer<typeof configSchema>;

/** What the stage job hands the push job beside the patch. */
export type Report = z.infer<typeof reportSchema>;

/** A change the label's rule left out of the commit: `without` is the refused deletion that took an allowed change along, or null. */
type Dropped = z.infer<typeof droppedSchema>;

/** The pull request event a run answers, read from the event payload. */
export interface PullRequestEvent {
  /** The trigger: the label, or a push to the pull request. */
  kind: FixEvent;

  /** The pull request's number. */
  number: number;

  /** The head commit the event names, the sha the fix is built on and leased to. */
  sha: string;

  /** The head branch's name. */
  ref: string;

  /** The login of the pull request's author. */
  author: string;

  /** How many files the pull request changes, when the payload says. */
  changedFiles: number | undefined;
}

/** What the stage phase is asked. */
export interface StageRequest {
  /** The trigger, which picks the rule for a change outside the lists. */
  kind: FixEvent;

  /** The event's allow-lists. */
  lists: Lists;

  /** The checkout the hook ran in. */
  repository: string;

  /** The directory the patch and the report are written to. */
  out: string;

  /** The hook's `findings` output. */
  findings: string;

  /** The hook's `subject` output. */
  subject: string;
}

/** How the push reaches the remote with the job's token, never spelled in a URL or an argument. */
export interface Credential {
  /** The server the remote lives on, as GITHUB_SERVER_URL spells it. */
  server: string;

  /** The job's token. */
  token: string;
}

/** What the push phase is asked. */
export interface PushRequest {
  /** The event the run answers, read by this job. */
  event: PullRequestEvent;

  /** The event's allow-lists, read by this job from the default branch. */
  lists: Lists;

  /** A checkout of the event's head sha that no pull request code ran in. */
  repository: string;

  /** The directory the stage job's artifact was downloaded to. */
  staged: string;

  /** The commit's subject, already judged. */
  subject: string;

  /** The push's credential, or null for a remote that asks for none. */
  credential: Credential | null;
}

/** The push phase's result. */
export interface PushResult {
  /** How the run ended. */
  outcome: Outcome;

  /** The sticky notice, empty when there is nothing to say. */
  notice: string;
}

/**
 * The `autofix-config` the plan action printed.
 *
 * @throws {Error} the text is not that document
 */
export function parseConfig(text: string): Config {
  return configSchema.parse(JSON.parse(text));
}

/** Whether `name` is the fix label. A workflow expression compares without case, so every phase must too. */
function isFixLabel(name: string | undefined): boolean {
  return name?.toLowerCase() === LABEL;
}

/**
 * The event a run answers, from the payload GitHub wrote for the run.
 *
 * @throws {Error} the payload is not a pull request event, or its label is not the fix label
 */
export function parseEvent(text: string): PullRequestEvent {
  const payload = eventSchema.parse(JSON.parse(text));
  const labeled = payload.action === "labeled";
  if (labeled && !isFixLabel(payload.label?.name)) {
    throw new Error(`the label is '${payload.label?.name}', not ${LABEL}: nothing to fix`);
  }

  const { number, head, user, changed_files: changedFiles } = payload.pull_request;
  return {
    kind: labeled ? "label" : "push",
    number,
    sha: head.sha,
    ref: head.ref,
    author: user.login,
    changedFiles,
  };
}

/**
 * Whether the event starts a fix. The label always does. A push does when the registration declares a `push` block
 * and one of the pull request's changed files matches its `on` list.
 *
 * @param changedFiles - lists the pull request's changed files, read only for a push with a `push` block
 */
export function startsFix(
  event: PullRequestEvent,
  config: Config,
  changedFiles: () => string[],
): boolean {
  if (event.kind === "label") return true;

  const on = config.push?.on;
  if (on === undefined) return false;

  // The listing stops at this many files, so a larger pull request is fixed without asking which ones.
  if ((event.changedFiles ?? 0) > LISTED_FILES_MAX) return true;

  return changedFiles().some((file) => on.some((pattern) => matches(pattern, file)));
}

/**
 * The hook's subject as the commit-names gate is asked about it, or empty for none: one line of printable ASCII
 * that no log reads as a workflow command. The gate prints what it judges, and it reads a second line as a body
 * and passes it, which would ride into the commit.
 */
export function candidateSubject(reported: string): string {
  const oneLine = reported.length <= SUBJECT_MAX && ONE_PRINTABLE_LINE.test(reported);
  const command = reported.startsWith("::") || reported.includes("##[");

  return oneLine && !command ? reported : "";
}

/** The commit subject: the candidate when the commit-names gate accepted it, else the default. */
export function subjectOf(candidate: string, accepted: boolean): string {
  return accepted && candidate !== "" ? candidate : DEFAULT_SUBJECT;
}

/** The commit message: the subject, and for a Dependabot pull request the line that keeps Dependabot rebasing it. */
function messageFor(subject: string, author: string): string[] {
  return author === DEPENDABOT ? [subject, DEPENDABOT_SKIP] : [subject];
}

/**
 * A child's words for the log. The runner reads a line that opens with `::`, and a `##[` anywhere in a line, as a
 * command, so each line goes behind a prefix and each `##[` is split.
 */
function quotedOutput(text: string): string {
  return text
    .trim()
    .split(/\r\n|\r|\n/)
    .map((line) => `  | ${line.replaceAll("##[", "## [")}`)
    .join("\n");
}

function gitEnv(config: readonly (readonly [string, string])[]): Record<string, string> {
  const variables: Record<string, string> = {
    GIT_CONFIG_COUNT: String(config.length),
    GIT_TERMINAL_PROMPT: "0",
  };
  config.forEach(([key, value], index) => {
    variables[`GIT_CONFIG_KEY_${index}`] = key;
    variables[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  return variables;
}

function git(
  tools: Tools,
  cwd: string,
  args: string[],
  extra: Record<string, string> = {},
  timeoutMs = GIT_BOUND_MS,
): RunResult {
  return tools.run(["git", ...args], { cwd, timeoutMs, env: { ...gitEnv(LOCKED_GIT), ...extra } });
}

function mustGit(
  tools: Tools,
  cwd: string,
  args: string[],
  extra: Record<string, string> = {},
): string {
  const result = git(tools, cwd, args, extra);
  if (!succeeded(result.exit)) {
    throw new Error(`git ${args[0]} failed: ${failureDetail(result)}`);
  }

  return result.stdout;
}

/** The staged changes, read from a file git wrote: a name's bytes survive there, and a child's output is read as text. */
function stagedChanges(tools: Tools, repository: string): RawChange[] {
  using scratch = mkdtempDisposableSync(join(tmpdir(), "autofix-"));
  const listing = join(scratch.path, "staged.raw");
  const raw = ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"];
  mustGit(tools, repository, [...raw, `--output=${listing}`]);

  return parseRawDiff(readFileSync(listing));
}

/**
 * Takes `changes` out of the index, each by its own bytes.
 *
 *   added -> `rm --cached`: a file's name is that file alone
 *   other -> `reset`: brings back the file HEAD holds
 *
 * `reset` reads a name as everything under it. On an added file that took a directory's place, it would bring the
 * directory's deleted files back.
 */
function unstage(tools: Tools, repository: string, changes: readonly RawChange[]): void {
  const added = changes.filter((change) => change.status === "A");
  const other = changes.filter((change) => change.status !== "A");
  const steps: [string[], RawChange[]][] = [
    [["rm", "--cached", "--quiet"], added],
    [["reset", "--quiet"], other],
  ];
  using scratch = mkdtempDisposableSync(join(tmpdir(), "autofix-"));
  const pathspecs = join(scratch.path, "pathspecs");
  for (const [command, group] of steps) {
    if (group.length === 0) continue;

    writeFileSync(pathspecs, Buffer.concat(group.flatMap(({ name }) => [name, Buffer.alloc(1)])));
    const named = [`--pathspec-from-file=${pathspecs}`, "--pathspec-file-nul"];
    mustGit(tools, repository, [...command, ...named], { GIT_LITERAL_PATHSPECS: "1" });
  }
}

/** A staged change's identity: the name's own bytes and what happened to it. */
function changeKey({ name, status }: RawChange): string {
  return `${status} ${name.toString("hex")}`;
}

/**
 * Takes the `rejected` changes out of the index and returns every change that left it, read from the index itself.
 *
 * Git holds a name as a file or as a directory. Bringing back a deleted `d/f` evicts a staged file `d`, and bringing
 * back a deleted `f` evicts a staged `f/x`: an allowed change leaves with the refused deletion, and is named with it.
 */
function drop(
  tools: Tools,
  repository: string,
  staged: readonly RawChange[],
  rejected: readonly Rejection[],
): Dropped[] {
  // By the decoded name: two names that decode alike are both not UTF-8, and both dropped.
  const refused = new Set(rejected.map(({ path }) => path));
  unstage(
    tools,
    repository,
    staged.filter(({ path }) => refused.has(path)),
  );

  const kept = new Set(stagedChanges(tools, repository).map(changeKey));
  const deletions = staged.filter(({ path, status }) => status === "D" && refused.has(path));

  return staged
    .filter((change) => !kept.has(changeKey(change)))
    .map(({ path }) => {
      if (refused.has(path)) return { path, without: null };

      const displacing = deletions.find(
        (deletion) => deletion.path.startsWith(`${path}/`) || path.startsWith(`${deletion.path}/`),
      );
      return { path, without: displacing?.path ?? null };
    });
}

/** Why each dropped change is not carried, for the run's annotations. */
function droppedReasons(dropped: readonly Dropped[], rejected: readonly Rejection[]): string[] {
  const reasons = new Map(rejected.map(({ path, reason }) => [path, reason]));

  return dropped.map(({ path, without }) => {
    const displaced =
      without === null ? "left the index with a dropped change" : displacedBy(without);
    return `${quoted(path)} (${reasons.get(path) ?? displaced})`;
  });
}

/**
 * Stages what the hook changed and the lists allow, and writes the patch and the report for the push job.
 *
 * @returns whether the patch carries a change
 * @throws {Error} a git command failed
 */
export function stageFix(request: StageRequest, tools: Tools): boolean {
  const { repository, out } = request;
  mustGit(tools, repository, ["add", "--all"]);

  const changes = stagedChanges(tools, repository);
  const judgment = judge(request.kind, changes, request.lists);
  mkdirSync(out, { recursive: true });
  if (judgment.kind === "refuse") mustGit(tools, repository, ["reset", "--quiet"]);

  const rejected = judgment.kind === "refuse" ? judgment.refused : judgment.dropped;
  const dropped = judgment.kind === "stage" ? drop(tools, repository, changes, rejected) : [];
  const notCarried =
    judgment.kind === "refuse"
      ? rejected.map(({ path, reason }) => `${quoted(path)} (${reason})`)
      : droppedReasons(dropped, rejected);
  for (const line of notCarried.slice(0, WARNED_PATHS)) {
    tools.log.warning(`not carried by the fix: ${line}`);
  }

  const patch = join(out, PATCH_FILE);
  const diff = ["diff", "--cached", "--binary", "--full-index", "--no-renames", "--no-color"];
  mustGit(tools, repository, [...diff, "--no-ext-diff", "--no-textconv", `--output=${patch}`]);

  // Cut to the report's caps here, so an honest hook's long output is shortened and never refused.
  const cut = (path: string) => path.slice(0, REPORT_CAPS.path);
  const report: Report = {
    subject: request.subject.slice(0, REPORT_CAPS.subject),
    findings: request.findings.slice(0, REPORT_CAPS.findings),
    dropped: dropped.slice(0, REPORT_CAPS.paths).map(({ path, without }) => ({
      path: cut(path),
      without: without === null ? null : cut(without),
    })),
    refused:
      judgment.kind === "refuse"
        ? rejected.slice(0, REPORT_CAPS.paths).map(({ path }) => cut(path))
        : [],
  };
  writeFileSync(join(out, REPORT_FILE), JSON.stringify(report));

  return lstatSync(patch).size > 0;
}

/** A file of the downloaded artifact; a link, a directory, or nothing where a regular file belongs is refused. */
function stagedFile(directory: string, name: string): { path: string; size: number } {
  const path = join(directory, name);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    throw new Error(`the staged ${name} is missing or is not a regular file`);
  }

  return { path, size: stat.size };
}

function readReport(directory: string): Report {
  const { path, size } = stagedFile(directory, REPORT_FILE);
  if (size > REPORT_MAX_BYTES) throw new Error(`the staged ${REPORT_FILE} is over its size cap`);

  const parsed = reportSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`the staged ${REPORT_FILE} is not a report`);

  return parsed.data;
}

/** The hook's subject from the staged report, for the caller to put to the commit-names gate; empty for none. */
export function reportedSubject(staged: string): string {
  return candidateSubject(readReport(staged).subject);
}

function unnamed(paths: readonly string[]): NamedPath[] {
  return paths.map((path) => ({ path, reason: null }));
}

function pushConfig(credential: Credential | null): readonly [string, string][] {
  if (credential === null) return LOCKED_GIT;

  const basic = Buffer.from(`x-access-token:${credential.token}`).toString("base64");
  core.setSecret(basic);

  return [
    ...LOCKED_GIT,
    [`http.${credential.server}/.extraheader`, `AUTHORIZATION: basic ${basic}`],
  ];
}

/** The branch's sha on the remote: empty when the branch is gone, null when the remote could not be read. */
function remoteHead(request: PushRequest, tools: Tools): string | null {
  const branch = `refs/heads/${request.event.ref}`;
  const args = ["ls-remote", "origin", branch];
  const result = git(tools, request.repository, args, gitEnv(pushConfig(request.credential)));
  if (!succeeded(result.exit)) return null;

  // git matches the pattern against the tail of a ref's name, so refs/heads/a/refs/heads/<branch> is listed too.
  const shaByName = new Map(
    result.stdout.split("\n").map((record): [string, string] => {
      const [sha, name] = record.split("\t");
      return [name, sha];
    }),
  );

  return shaByName.get(branch) ?? "";
}

function commitFix(request: PushRequest, tools: Tools): string {
  const { repository, event, subject } = request;
  // The commit carries the date of the commit it fixes, so a rerun builds the same sha and finds it pushed.
  const date = mustGit(tools, repository, ["show", "--no-patch", "--format=%cI", "HEAD"]).trim();
  const identity = {
    GIT_AUTHOR_NAME: BOT.name,
    GIT_AUTHOR_EMAIL: BOT.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: BOT.name,
    GIT_COMMITTER_EMAIL: BOT.email,
    GIT_COMMITTER_DATE: date,
  };
  const message = messageFor(subject, event.author).flatMap((paragraph) => ["-m", paragraph]);
  mustGit(tools, repository, ["commit", "--quiet", "--no-verify", ...message], identity);

  return mustGit(tools, repository, ["rev-parse", "HEAD"]).trim();
}

function pushCommit(request: PushRequest, commit: string, tools: Tools): Outcome {
  const { repository, event, subject } = request;
  const branch = `refs/heads/${event.ref}`;
  const args = [
    "push",
    "--no-verify",
    `--force-with-lease=${branch}:${event.sha}`,
    "origin",
    `${commit}:${branch}`,
  ];
  const pushed = git(
    tools,
    repository,
    args,
    gitEnv(pushConfig(request.credential)),
    PUSH_BOUND_MS,
  );
  if (succeeded(pushed.exit)) return { kind: "pushed", commit, subject };

  tools.log.info(quotedOutput(pushed.stderr));
  // How a rejected push ended is read from the branch, never from git's words.
  const head = remoteHead(request, tools);
  const detail = "git push was rejected; the run's log has git's words.";
  if (head === null) return { kind: "failed", branch: "unread", detail };

  // A rerun rebuilds the same commit, which is on the branch already.
  if (head === commit) return { kind: "pushed", commit, subject };

  if (head === event.sha) return { kind: "failed", branch: "unmoved", detail };

  return { kind: "superseded", branch: head === "" ? "gone" : "moved" };
}

function applyAndPush(request: PushRequest, report: Report, tools: Tools): Outcome {
  const { repository, event, lists } = request;
  if (report.refused.length > 0) {
    return {
      kind: "refused",
      why: "on a push the fixer's changes are committed together or not at all, and these are outside the registration's `autofix.push` lists.",
      refused: unnamed(report.refused),
    };
  }

  const patch = stagedFile(request.staged, PATCH_FILE);
  if (patch.size === 0) return { kind: "nothing" };

  const head = mustGit(tools, repository, ["rev-parse", "HEAD"]).trim();
  if (head !== event.sha)
    throw new Error(`the checkout is at ${head}, not the event's ${event.sha}`);

  // Into the index alone: the patch never writes this job's work tree.
  const applied = git(tools, repository, ["apply", "--cached", "--whitespace=nowarn", patch.path]);
  if (!succeeded(applied.exit)) {
    tools.log.info(quotedOutput(applied.stderr));
    const detail = `the patch does not apply to ${event.sha}.`;
    return { kind: "failed", branch: "untouched", detail };
  }

  const changes = stagedChanges(tools, repository);
  const refused = changes.flatMap((change): NamedPath[] => {
    const reason = rejection(change, lists);
    return reason === null ? [] : [{ path: change.path, reason }];
  });
  if (refused.length > 0) {
    return { kind: "refused", why: "the patch changes paths a fix may not carry.", refused };
  }

  if (changes.length === 0) return { kind: "nothing" };

  return pushCommit(request, commitFix(request, tools), tools);
}

/**
 * Judges the staged patch against the lists, commits it on the event's sha, pushes it leased to that sha, and words
 * the notice.
 *
 * @throws {Error} the staged files are not a patch and a report, the checkout is not at the event's sha, or a git
 *   command other than the apply and the push failed
 */
export function pushFix(request: PushRequest, tools: Tools): PushResult {
  const report = readReport(request.staged);
  const outcome = applyAndPush(request, report, tools);
  const dropped = report.dropped.map(({ path, without }) => ({
    path,
    reason: without === null ? null : displacedBy(without),
  }));
  const remarks: Remarks = { findings: report.findings, dropped };

  return { outcome, notice: noticeOf(request.event.kind, outcome, remarks) };
}

function api(tools: Tools, args: string[]): RunResult {
  return tools.run(["gh", "api", ...args], { timeoutMs: API_BOUND_MS });
}

function labelled(repository: string, event: PullRequestEvent, tools: Tools): boolean {
  const route = `repos/${repository}/issues/${event.number}/labels`;
  const listed = api(tools, ["--paginate", route, "--jq", ".[].name"]);
  if (!succeeded(listed.exit)) {
    throw new Error(`reading the pull request's labels failed: ${failureDetail(listed)}`);
  }

  return listed.stdout.split("\n").some(isFixLabel);
}

/**
 * Takes the fix label off the pull request. A label already gone is the end state, so a rerun passes.
 *
 * @throws {Error} the labels cannot be read, or the label is still there after the removal
 */
export function removeLabel(repository: string, event: PullRequestEvent, tools: Tools): void {
  if (!labelled(repository, event, tools)) return;

  const route = `repos/${repository}/issues/${event.number}/labels/${LABEL}`;
  const removed = api(tools, ["--method", "DELETE", "--silent", route]);
  if (succeeded(removed.exit)) return;

  // Another run may have removed it between the read and the call: the labels say, not gh's words.
  if (labelled(repository, event, tools)) {
    throw new Error(`removing the ${LABEL} label failed: ${failureDetail(removed)}`);
  }
}

function changedFiles(repository: string, event: PullRequestEvent, tools: Tools): string[] {
  const route = `repos/${repository}/pulls/${event.number}/files`;
  const names = ".[] | (.filename, (.previous_filename // empty)) | @json";
  const listed = api(tools, ["--paginate", route, "--jq", names]);
  if (!succeeded(listed.exit)) {
    throw new Error(`listing the pull request's files failed: ${failureDetail(listed)}`);
  }

  return listed.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => z.string().parse(JSON.parse(line)));
}

function requiredLists(kind: FixEvent, config: Config): Lists {
  const lists = kind === "label" ? config.label : config.push;
  if (lists === null) {
    throw new Error("the registration on the default branch declares no autofix.push block");
  }

  return lists;
}

async function main(): Promise<void> {
  const phase = requireEnv("PHASE");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const event = parseEvent(readFileSync(requireEnv("GITHUB_EVENT_PATH"), "utf8"));
  const tools: Tools = { run: capture, log: core };

  if (phase === "unlabel" || phase === "fork") {
    removeLabel(repository, event, tools);
    if (phase === "fork") core.setOutput("notice", FORK_NOTICE);
    return;
  }

  if (phase === "read") {
    core.setOutput("subject", reportedSubject(requireEnv("STAGED_DIRECTORY")));
    return;
  }

  const config = parseConfig(requireEnv("CONFIG"));
  if (phase === "plan") {
    const run = startsFix(event, config, () => changedFiles(repository, event, tools));
    core.setOutput("run", String(run));
    return;
  }

  const lists = requiredLists(event.kind, config);
  if (phase === "stage") {
    const out = join(requireEnv("RUNNER_TEMP"), "autofix-staged");
    const request = {
      kind: event.kind,
      lists,
      repository: requireEnv("REPOSITORY_DIRECTORY"),
      out,
    };
    const changed = stageFix(
      { ...request, findings: env("FINDINGS"), subject: env("SUBJECT") },
      tools,
    );
    core.setOutput("directory", out);
    core.setOutput("changed", String(changed));
    return;
  }

  if (phase !== "push") {
    throw new Error(`phase must be plan, stage, read, push, unlabel, or fork; got '${phase}'`);
  }

  const server = env("GITHUB_SERVER_URL", "https://github.com");
  const result = pushFix(
    {
      event,
      lists,
      repository: requireEnv("REPOSITORY_DIRECTORY"),
      staged: requireEnv("STAGED_DIRECTORY"),
      subject: subjectOf(candidateSubject(env("SUBJECT")), env("SUBJECT_ACCEPTED") === "true"),
      credential: { server, token: requireEnv("GH_TOKEN") },
    },
    tools,
  );
  core.setOutput("outcome", result.outcome.kind);
  core.setOutput("notice", result.notice);
  if (result.notice !== "") await core.summary.addRaw(result.notice, true).write();

  if (result.outcome.kind === "refused" || result.outcome.kind === "failed") {
    core.setFailed(`the fix was not pushed: ${result.outcome.kind}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (cause) {
    core.setFailed(quotedFailure(messageOf(cause)));
  }
}
