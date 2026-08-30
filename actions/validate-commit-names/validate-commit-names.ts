// Validates that every commit subject in a push/PR range is a Conventional
// Commit. Vendored from Vivswan/copilot-env (.github/scripts/
// validate-commit-names.cjs), converted to TypeScript; runs under bun.
// The subject grammar itself lives in ./subject.ts (single source, shared
// with this repo's commit-msg hook - the header there has the model).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { conventionalSubject, isMergeSubject, subject } from "./subject.ts";

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

// True when `rev` resolves to a commit present in this checkout. A force-push
// orphans the old tip (and a shallow clone may never fetch it), so `before`
// can name a commit that no longer exists -- `git rev-list before..after`
// would then fail fatally. We use this to fall back to the push payload.
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
    // Only diff a range when both endpoints are real and reachable here;
    // otherwise (new branch, or a force-push that orphaned `before`) validate
    // the commits GitHub listed in this push payload instead.
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
  const failures = checked.filter((commit) => !conventionalSubject.test(commit.subject));

  console.log(`Checked ${checked.length} non-merge commit subject(s).`);

  if (failures.length > 0) {
    const lines = failures.map((commit) => `- ${commit.sha.slice(0, 7)} ${commit.subject}`);
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
