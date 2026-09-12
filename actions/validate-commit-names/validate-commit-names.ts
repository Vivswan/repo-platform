import { execFileSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { commitlint, type Verdict } from "./commitlint.ts";

const zeroSha = /^0{40}$/;

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

type Judged = { range: [from: string, to: string] } | { messages: string[] };

// commitlint refuses a range whose ends share no merge-base, and a force-push can orphan the old tip (a shallow clone
// may never fetch it) or re-root the history: one probe answers both, and either way the range is not judgeable.
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

function judged(): Judged {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const payload = eventPayload();

  if (eventName === "pull_request") {
    const base = payload.pull_request?.base?.sha;
    const head = payload.pull_request?.head?.sha;
    if (!base || !head) {
      throw new Error("pull_request event is missing base/head SHAs.");
    }
    return { range: [base, head] };
  }

  if (eventName === "push") {
    const { before, after } = payload;
    // A new branch's `before` is the zero sha and a force-push orphans it: the push payload is the fallback.
    if (before && after && !zeroSha.test(before) && rangeJudgeable(before, after)) {
      return { range: [before, after] };
    }
    const listed = payload.commits ?? [];
    // GitHub truncates the push payload's commit list at 20 entries; at
    // exactly 20 there is no way to tell truncation from a 20-commit push.
    if (listed.length >= 20) {
      console.log(
        "::warning::push payload may be truncated (it lists 20 commits, GitHub's cap) and the base..head range is not resolvable here; commits beyond the payload, if any, were not validated",
      );
    }
    return { messages: listed.map((commit) => commit.message) };
  }

  return { messages: [] };
}

function report(verdict: Verdict): number {
  writeSync(1, verdict.report);
  return verdict.status;
}

function main(): void {
  const title = process.env.PR_TITLE ?? "";
  if (title !== "") {
    process.exitCode = report(commitlint([], title));
    return;
  }
  const target = judged();
  if ("range" in target) {
    process.exitCode = report(commitlint(["--from", target.range[0], "--to", target.range[1]]));
    return;
  }
  // Every message gets its verdict before the step fails, one launch each: commitlint reads one message per stdin.
  process.exitCode = Math.max(
    0,
    ...target.messages.map((message) => report(commitlint([], message))),
  );
}

main();
