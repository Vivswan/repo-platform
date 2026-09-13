// The action is commitlint over the config beside it, fed by two callers: the fleet's commit-names step hands over the
// event's commit range, the pr-title workflow hands over the PR title (no checkout, no event payload). Every row here
// runs the action as CI runs it and reads the whole verdict: the exit status and commitlint's problem list.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BoundedSpawnResult, boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { ONE_SCOPE, SUBJECT_CASE, TYPE_ENUM, verdict } from "../../shared/commitlint_verdict.ts";
import { harnessBound } from "../../shared/harness_bound.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const root = join(import.meta.dir, "../../..");
const ACTION = join(root, "actions/validate-commit-names/validate-commit-names.ts");
const scratch = temp.dir("validate-commit-names-");
let serial = 0;

// No user or system git config: a global commit.gpgsign or core.commentChar would change what the scratch repo stores.
const GIT_PINS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function runAction(env: Record<string, string>, cwd = root): BoundedSpawnResult {
  return boundedSpawnSync([process.execPath, ACTION], {
    cwd,
    env: { PATH: process.env.PATH, ...GIT_PINS, ...env },
  });
}

function eventFile(payload: unknown): string {
  const eventPath = join(scratch, `event-${serial++}.json`);
  writeFileSync(eventPath, JSON.stringify(payload));
  return eventPath;
}

// config-conventional caps the header at 100; the fleet turns that rule off (its titles run long by house style).
const HEADER_101 = `fix: ${"x".repeat(96)}`;

const TITLES: [title: string, problems: string[]][] = [
  ["fix(a): x", []],
  ["feat!: x", []],
  ["fix(a)!: x", []],
  ["docs(all-green/build.v2_1): x", []],
  ["fix:  x", []],
  ["amend! wip", []],
  ['Reapply "feat: x"', []],
  [HEADER_101, []],
  ["fix(a,b): x", [ONE_SCOPE]],
  ["fix(a, b): x", [ONE_SCOPE]],
  ["fix(a,b)!: x", [ONE_SCOPE]],
  ["fix(a b): x", [ONE_SCOPE]],
  ["fix(): x", [ONE_SCOPE]],
  ["fix(a,b)(c): x", [ONE_SCOPE]],
  ["fix(a)(c): x", [ONE_SCOPE]],
  ["fix(a)!(c): x", [ONE_SCOPE]],
  ["fix(a):(c): x", [ONE_SCOPE]],
  // The parser reads the scope up to the last `): `, and so will release-please on the landed subject.
  ["fix(core): handle fn(): safely", [ONE_SCOPE]],
  ["fix: Repair installer", [SUBJECT_CASE]],
  ["fix: x.", ["subject may not end with full stop [subject-full-stop]"]],
  ["fix: x ", ["header must not end with whitespace [header-trim]"]],
  ["fix(a):x", ["subject may not be empty [subject-empty]", "type may not be empty [type-empty]"]],
  ["Fix(a): x", ["type must be lower-case [type-case]", TYPE_ENUM]],
  ["bogus(a): x", [TYPE_ENUM]],
  ["(a): x", ["type may not be empty [type-empty]"]],
];

describe("the PR title judged as the squash subject it becomes", () => {
  for (const [title, expected] of TITLES) {
    test(`${expected.length === 0 ? "accepted" : expected.join("; ")}: ${JSON.stringify(title)}`, () => {
      expect(verdict(runAction({ PR_TITLE: title }))).toEqual({
        exitCode: expected.length === 0 ? 0 : 1,
        stderr: "",
        problems: expected,
      });
    });
  }
});

type Git = (args: string[], stdin?: string) => string;

/** A fresh repository under `scratch` holding one root commit, and its git, which throws on any failure. A message
 *  arrives on stdin (`commit -F -`) when an argument would not carry it: Linux caps one argument at 128 KiB. */
function scratchGit(): { repo: string; root: string; git: Git } {
  const repo = join(scratch, `repo-${serial++}`);
  const git: Git = (args, stdin) => {
    const result = boundedSpawnSync(["git", ...args], {
      cwd: repo,
      env: { PATH: process.env.PATH, ...GIT_PINS },
      stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "chore: root"]);
  return { repo, root: git(["rev-parse", "HEAD"]), git };
}

/** A scratch history whose base..head holds, oldest first: an accepted commit with an unwrapped 150-character body
 *  line, a merge that brings in a comma-scoped commit, and a Sentence-case commit; `orphan` is a root unrelated to it. */
function scratchRepo(): { repo: string; base: string; head: string; orphan: string } {
  const { repo, root: base, git } = scratchGit();
  git(["commit", "-q", "--allow-empty", "-m", `feat(a): ok\n\n${"y".repeat(150)}`]);
  git(["checkout", "-q", "-b", "side"]);
  git(["commit", "-q", "--allow-empty", "-m", "docs(a,b): two scopes"]);
  git(["checkout", "-q", "main"]);
  git(["merge", "-q", "--no-ff", "--no-edit", "side"]);
  git(["commit", "-q", "--allow-empty", "-m", "fix: Sentence case"]);
  const head = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "--orphan", "other"]);
  git(["commit", "-q", "--allow-empty", "-m", "chore: other root"]);
  const orphan = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);
  return { repo, base, head, orphan };
}

// Newest first, the order commitlint reports a range in; the merge commit itself is ignored.
const RANGE_PROBLEMS = [SUBJECT_CASE, ONE_SCOPE];

describe("the event's commit range", () => {
  const { repo, base, head, orphan } = scratchRepo();

  test("pull_request: base..head from the event, merge subjects ignored", () => {
    const eventPath = eventFile({ pull_request: { base: { sha: base }, head: { sha: head } } });
    const result = runAction(
      { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
      repo,
    );
    expect(verdict(result)).toEqual({ exitCode: 1, stderr: "", problems: RANGE_PROBLEMS });
  });

  test("push with both ends resolvable: before..after", () => {
    const eventPath = eventFile({ before: base, after: head, commits: [] });
    const result = runAction({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath }, repo);
    expect(verdict(result)).toEqual({ exitCode: 1, stderr: "", problems: RANGE_PROBLEMS });
  });

  test("a pull_request event without its shas fails instead of judging nothing", () => {
    const eventPath = eventFile({ pull_request: {} });
    const result = runAction({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pull_request event is missing base/head SHAs.");
  });

  // A new branch's `before` is the zero sha and a force-push orphans it or re-roots the history: the payload's
  // messages are judged instead. A body line shaped like a merge subject exempts nothing.
  const FALLBACKS: [name: string, before: string][] = [
    ["zero before sha", "0".repeat(40)],
    ["before sha no longer in the repository", "1".repeat(40)],
    ["before sha from an unrelated history", orphan],
  ];
  for (const [name, before] of FALLBACKS) {
    test(`push, ${name}: the payload's commit messages, one verdict each`, () => {
      const eventPath = eventFile({
        before,
        after: head,
        commits: [
          "style(contract): x",
          "docs(a,b): x\n\nMerge branch 'topic' into main",
          "wip: x",
        ].map((message, index) => ({ id: String(index + 1).repeat(40), message })),
      });
      const result = runAction({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath }, repo);
      expect(verdict(result)).toEqual({
        exitCode: 1,
        stderr: "",
        problems: [ONE_SCOPE, TYPE_ENUM],
      });
    });
  }

  test(
    "a 20-commit payload is warned about as possibly truncated, and still judged to the last entry",
    () => {
      const eventPath = eventFile({
        before: "0".repeat(40),
        after: head,
        commits: Array.from({ length: 20 }, (_, index) => ({
          id: String(index).repeat(40),
          message: index === 19 ? "wip: x" : `fix: commit ${index}`,
        })),
      });
      const result = runAction({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath });
      expect([result.stdout.startsWith("::warning::"), verdict(result)]).toEqual([
        true,
        { exitCode: 1, stderr: "", problems: [TYPE_ENUM] },
      ]);
    },
    harnessBound(60_000),
  ); // twenty commitlint launches, one per payload message

  // commitlint's CLI drops a whitespace-only message before any rule sees it; the action refuses it by sha.
  test("a whitespace-only commit message is refused, not dropped", () => {
    const { repo: blank, root, git } = scratchGit();
    git(["commit", "-q", "--allow-empty", "--allow-empty-message", "-m", " "]);
    const sha = git(["rev-parse", "HEAD"]);
    const refused = { exitCode: 1, stdout: `commit ${sha}: the message is empty\n`, stderr: "" };
    const range = eventFile({ pull_request: { base: { sha: root }, head: { sha } } });
    expect(
      runAction({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: range }, blank),
    ).toEqual(refused);
    const payload = eventFile({
      before: "0".repeat(40),
      after: sha,
      commits: [{ id: sha, message: " " }],
    });
    expect(runAction({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: payload }, blank)).toEqual(
      refused,
    );
  });

  // The range's log is the PR's size: two 600 KiB bodies exceed Node's default 1 MiB stdout cap.
  test("a range whose log exceeds 1 MiB is judged, not cut", () => {
    const { repo: big, root, git } = scratchGit();
    const body = "a line of the body\n".repeat(32 * 1024);
    git(["commit", "-q", "--allow-empty", "-F", "-"], `fix(a): first\n\n${body}`);
    git(["commit", "-q", "--allow-empty", "-F", "-"], `fix(b): second\n\n${body}`);
    const head = git(["rev-parse", "HEAD"]);
    const range = eventFile({ pull_request: { base: { sha: root }, head: { sha: head } } });
    expect(runAction({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: range }, big)).toEqual(
      {
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    );
  });

  test("another event judges nothing", () => {
    const eventPath = eventFile({});
    const result = runAction({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});
