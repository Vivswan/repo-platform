import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isMergeSubject, refusal, subject } from "./subject.ts";

const zeroSha = /^0{40}$/;

interface Commit {
  sha: string;
  subject: string;
}

interface PushPayloadCommit {
  id: string;
  message: string;
}

interface EventPayload {
  pull_request?: { base?: { sha?: string }; head?: { sha?: string } };
  before?: string;
  after?: string;
  commits?: PushPayloadCommit[];
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// A force-push orphans the old tip (and a shallow clone may never fetch it), so `before` can name a commit that
// no longer exists, and `git rev-list before..after` would then fail fatally.
function revExists(rev: string): boolean {
  try {
    // stdio "ignore" keeps git's "fatal: Not a valid object name" off the log
    // -- a missing `before` is an expected, handled case, not an error.
    execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shasInRange(range: string): string[] {
  const output = git(["rev-list", "--reverse", range]);
  return output ? output.split(/\r?\n/) : [];
}

function commitSubject(sha: string): string {
  return subject(git(["show", "-s", "--format=%s", sha]));
}

function eventPayload(): EventPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }
  return JSON.parse(readFileSync(eventPath, "utf8")) as EventPayload;
}

function listCommits(): Commit[] {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const payload = eventPayload();

  if (eventName === "pull_request") {
    const base = payload.pull_request?.base?.sha;
    const head = payload.pull_request?.head?.sha;
    if (!base || !head) {
      throw new Error("pull_request event is missing base/head SHAs.");
    }
    return shasInRange(`${base}..${head}`).map((sha) => ({
      sha,
      subject: commitSubject(sha),
    }));
  }

  if (eventName === "push") {
    const before = payload.before;
    const after = payload.after;
    // A new branch's `before` is the zero sha and a force-push orphans it: the push payload is the fallback.
    if (before && after && !zeroSha.test(before) && revExists(before) && revExists(after)) {
      return shasInRange(`${before}..${after}`).map((sha) => ({
        sha,
        subject: commitSubject(sha),
      }));
    }
    const listed = payload.commits ?? [];
    // GitHub truncates the push payload's commit list at 20 entries; at
    // exactly 20 there is no way to tell truncation from a 20-commit push.
    if (listed.length >= 20) {
      console.log(
        "::warning::push payload may be truncated (it lists 20 commits, GitHub's cap) and the base..head range is not resolvable here; commits beyond the payload, if any, were not validated",
      );
    }
    return listed.map((commit) => ({
      sha: commit.id,
      subject: subject(commit.message),
    }));
  }

  return [];
}

function validateCommitNames(): void {
  const commits = listCommits();
  const checked = commits.filter((commit) => !isMergeSubject(commit.subject));
  const failures = checked.flatMap((commit) => {
    const reason = refusal(commit.subject);
    return reason === undefined ? [] : [{ ...commit, reason }];
  });

  console.log(`Checked ${checked.length} non-merge commit subject(s).`);

  if (failures.length > 0) {
    const lines = failures.map(
      (commit) => `- ${commit.sha.slice(0, 7)} ${commit.subject}\n  ${commit.reason}`,
    );
    console.error(
      [
        "Commit subjects must be Conventional Commits.",
        "Examples: `feat: add setup flow`, `fix: repair installer`, `feat!: simplify bootstrap`, `chore(main): release 3.0.0`.",
        "",
        ...lines,
      ].join("\n"),
    );
    process.exitCode = 1;
  }
}

validateCommitNames();
