import { execFileSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { commitlint, type Verdict } from "./commitlint.ts";

const zeroSha = /^0{40}$/;

interface Commit {
  sha: string;
  message: string;
}

interface EventPayload {
  pull_request?: { base?: { sha?: string }; head?: { sha?: string } };
  before?: string;
  after?: string;
  commits?: { id: string; message: string }[];
}

// A force-push can orphan the old tip (a shallow clone may never fetch it) or re-root the history; `git log` errors on
// the first and lists the whole new history on the second. One probe answers both: no merge-base, no judgeable range.
function rangeJudgeable(before: string, after: string): boolean {
  try {
    // stdio "ignore" keeps git's "fatal: Not a valid object name" off the log
    // -- a missing `before` is an expected, handled case, not an error.
    execFileSync("git", ["merge-base", before, after], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function eventPayload(): EventPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }
  return JSON.parse(readFileSync(eventPath, "utf8")) as EventPayload;
}

// Newest first. `-z` ends each record with NUL, so a message may hold any newline shape. No output cap: the log is
// the pull request's own size, and Node's 1 MiB default cut a two-commit range of long bodies.
function rangeCommits(from: string, to: string): Commit[] {
  const log = execFileSync("git", ["log", "-z", "--format=%H%n%B", `${from}..${to}`], {
    encoding: "utf8",
    maxBuffer: Infinity,
  });
  return log
    .split("\0")
    .filter((record) => record !== "")
    .map((record) => {
      const newline = record.indexOf("\n");
      return { sha: record.slice(0, newline), message: record.slice(newline + 1) };
    });
}

function judged(): Commit[] {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const payload = eventPayload();

  if (eventName === "pull_request") {
    const base = payload.pull_request?.base?.sha;
    const head = payload.pull_request?.head?.sha;
    if (!base || !head) {
      throw new Error("pull_request event is missing base/head SHAs.");
    }
    return rangeCommits(base, head);
  }

  if (eventName === "push") {
    const { before, after } = payload;
    // A new branch's `before` is the zero sha and a force-push orphans it: the push payload is the fallback.
    if (before && after && !zeroSha.test(before) && rangeJudgeable(before, after)) {
      return rangeCommits(before, after);
    }
    const listed = payload.commits ?? [];
    // GitHub truncates the push payload's commit list at 20 entries; at
    // exactly 20 there is no way to tell truncation from a 20-commit push.
    if (listed.length >= 20) {
      console.log(
        "::warning::push payload may be truncated (it lists 20 commits, GitHub's cap) and the base..head range is not resolvable here; commits beyond the payload, if any, were not validated",
      );
    }
    return listed.map(({ id, message }) => ({ sha: id, message }));
  }

  return [];
}

function report(verdict: Verdict): number {
  writeSync(1, verdict.report);
  return verdict.status;
}

// commitlint's CLI drops a whitespace-only message before any rule sees it (a range of them lints as nothing).
function judge(commit: Commit): number {
  if (commit.message.trim() === "") {
    writeSync(1, `commit ${commit.sha}: the message is empty\n`);
    return 1;
  }
  return report(commitlint(commit.message));
}

function main(): void {
  const title = process.env.PR_TITLE ?? "";
  if (title !== "") {
    process.exitCode = report(commitlint(title));
    return;
  }
  // Every commit gets its verdict before the step fails, one launch each: commitlint reads one message per stdin.
  process.exitCode = Math.max(0, ...judged().map(judge));
}

main();
