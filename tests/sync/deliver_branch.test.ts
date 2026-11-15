// The branch delivery's contract with the human reading the pull request (docs/platform/sync/operator.md, "Syncing a branch by label"),
// driven as the workflow drives it: the script spawned over a git stub and a fake GitHub API, one row per outcome. What would drift
// silently: the label staying on after a failure, a hold or a workflow-file diff reaching the push, a queued relabel
// losing the approval line, a refused push reported without git's own words.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SYNC_IDENTITY } from "../../.github/scripts/shared/git_identity.ts";
import { BOT_LOGIN } from "../../.github/scripts/shared/sticky_comment.ts";
import { prTitle } from "../../.github/scripts/sync/deliver.ts";
import type { SyncReport } from "../../.github/scripts/sync/writer/report.ts";
import { SYNC_LABEL } from "../../actions/shared/platform.ts";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { type FakeGithubServer, type FakeReply, spawnFakeGithub } from "../shared/fake_github";
import { FIXTURE_GITCONFIG, fixtureGit } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";
import {
  committedDiff,
  MISSING_PATH,
  MISSING_PATH_LINE,
  quietReport,
  WRITTEN_DIFF,
  writtenTree,
} from "../shared/written_tree";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/deliver_branch.ts");
const REPOSITORY = "Vivswan/some-repo";
const BRANCH = "feat/take-the-module";
const BUILD = "abcdef0123456789abcdef0123456789abcdef01";
const TIP = "1111111111111111111111111111111111111111";
const PUSHED = "2222222222222222222222222222222222222222";
const RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/9`;
const REPORT = "## Sync report\n\n### Review\n\nHold for review: no\n";
const PUSH_REFUSAL =
  "! [remote rejected] HEAD -> feat/take-the-module (protected branch hook declined)";
const REAL_GIT = Bun.which("git") ?? "git";
const EARLIER_COMMENT = {
  id: 777,
  body: "<!-- repo-platform sync-branch -->\nBuild `0000000` pushed.",
  user: { login: BOT_LOGIN },
};
const ISSUE = `repos/${REPOSITORY}/issues/42`;
const LABEL = `DELETE ${ISSUE}/labels/${encodeURIComponent(SYNC_LABEL)}`;
const COMMENTS = `${ISSUE}/comments`;

const GIT_LINES = [
  // With STUB_REAL_GIT set, every target call but the push runs the real git over the fixture checkout.
  'if [ -n "${STUB_REAL_GIT:-}" ]; then case "$*" in "-C target "*) case " $* " in *" push "*) ;; *) exec "$STUB_REAL_GIT" "$@" ;; esac ;; esac; fi',
  'case "$*" in',
  // The build checkout answers its commit; the target checkout answers what each row stages (NUL-separated paths),
  // the tip's author, and the commit before and after the sync commit.
  `  "-C build rev-parse HEAD") echo "${BUILD}" ;;`,
  '  *" diff --cached --name-only -z --no-renames") printf "%b" "${STUB_CHANGED:-}" ;;',
  '  *" log -1 --format=%an") echo "${STUB_AUTHOR:-}" ;;',
  `  *" rev-parse HEAD") if [ -f "$STUB_COMMITTED" ]; then echo "${PUSHED}"; else echo "${TIP}"; fi ;;`,
  '  *" commit "*) : >"$STUB_COMMITTED" ;;',
  `  *" push "*) if [ "\${STUB_PUSH_FAIL:-}" = 1 ]; then echo "${PUSH_REFUSAL}" >&2; exit 1; fi ;;`,
  "esac",
];
type Comment = { id: number; body: string; user: { login: string } };

/** The run's inputs:
 *    written   builds a real checkout under root/target and answers the writer's summary over it, so git then runs for real
 *    label     GitHub's answer to the label removal; the label came off when absent
 *    comments  the pull request's comments, one array per page; none when absent */
interface Options {
  migrate?: "success" | "failure";
  writer?: "success" | "failure" | "skipped";
  hold?: boolean;
  stub?: Record<string, string>;
  written?: (root: string) => SyncReport;
  label?: FakeReply;
  comments?: readonly (readonly Comment[])[];
}

/** What the run left behind:
 *    commentCall    the write that carried the body: a POST creates on the issue, a PATCH replaces the found comment by its id
 *    commitSubject  the `-m` the sync commit was made with, null when no commit was made */
interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  target: string;
  labelRemovalAsked: boolean;
  comment: string | null;
  commentCall: string | null;
  committed: boolean;
  commitSubject: string | null;
  pushAttempted: boolean;
  pushLease: string | null;
}

let api: FakeGithubServer;
let runs = 0;
beforeAll(async () => {
  api = await spawnFakeGithub({}, join(temp.dir("deliver-branch-api-"), "api.log"));
});
afterAll(() => api.stop());

function run(options: Options = {}): Run {
  const root = temp.dir("deliver-branch-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  const target = join(root, "target");
  mkdirSync(target);
  mkdirSync(join(root, "build"));
  writeFileSync(join(runnerTemp, "migrated.txt"), "");
  const summary = options.written?.(root) ?? quietReport(BUILD, options.hold ?? false);
  writeFileSync(join(runnerTemp, "summary.json"), JSON.stringify(summary));
  writeFileSync(join(runnerTemp, "sync.log"), REPORT);
  const committed = join(root, "committed");
  const git = argvStub(root, "git", GIT_LINES);
  const name = `run-${++runs}`;
  const pages = options.comments ?? [[]];
  api.routes(name, {
    [LABEL]: [options.label ?? { status: 200, body: [] }],
    [COMMENTS]: pages.map((body, index) => ({ status: 200, body, next: index < pages.length - 1 })),
    [`POST ${COMMENTS}`]: [{ status: 201, body: { id: 1 } }],
    [`PATCH repos/${REPOSITORY}/issues/comments/*`]: [{ status: 200, body: { id: 1 } }],
  });
  const result = boundedSpawnSync(["bun", SCRIPT], {
    cwd: root,
    env: {
      PATH: `${git.bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: REPOSITORY,
      PR_NUMBER: "42",
      BRANCH,
      RUN_URL,
      GH_TOKEN: "ghs_SENTINEL",
      GITHUB_API_URL: `${api.host}/${name}`,
      GITHUB_RETRY_BASE_MS: "0",
      MIGRATE_OUTCOME: options.migrate ?? "success",
      WRITER_OUTCOME: options.writer ?? "success",
      STUB_COMMITTED: committed,
      GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG,
      ...(options.written === undefined ? {} : { STUB_REAL_GIT: REAL_GIT }),
      ...(options.stub ?? {}),
    },
  });
  const writes = api.writes(name);
  const commented = writes.find((write) => write.path !== LABEL);
  const gitCalls = git.calls();
  const push = gitCalls.find((call) => call.includes("push"));
  const commit = gitCalls.find((call) => call.includes("commit"));
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    target,
    labelRemovalAsked: writes[0]?.path === LABEL,
    comment: (commented?.body as { body: string } | undefined)?.body ?? null,
    commentCall: commented?.path ?? null,
    committed: existsSync(committed),
    commitSubject: commit?.[commit.indexOf("-m") + 1] ?? null,
    pushAttempted: push !== undefined,
    pushLease: push?.find((arg) => arg.startsWith("--force-with-lease=")) ?? null,
  };
}

const APPROVAL = "GitHub holds the new head's pull_request run for approval";
const RELABEL_APPROVAL =
  "If a label run pushed this tip, GitHub holds its pull_request run for approval";

describe("the branch delivery's outcomes", () => {
  // Every row: the label is off whatever follows; the comment says what happened; a commit exists only when the
  // tree changed and nothing refused; red exactly when a human must act before the branch is what the label asked for.
  test.each<{
    reason: string;
    options: Options;
    exitCode: number;
    committed: boolean;
    pushAttempted: boolean;
    says: string[];
    saysNot: string[];
  }>([
    {
      reason: "a failed migration rung: red, the log tail, nothing committed",
      options: { migrate: "failure", writer: "skipped" },
      exitCode: 1,
      committed: false,
      pushAttempted: false,
      says: ["NOT pushed: a migration rung failed", REPORT.trim()],
      saysNot: ["the writer failed", APPROVAL],
    },
    {
      reason: "a failed writer: red, named as the writer's",
      options: { writer: "failure" },
      exitCode: 1,
      committed: false,
      pushAttempted: false,
      says: ["NOT pushed: the writer failed"],
      saysNot: ["a migration rung failed"],
    },
    {
      reason: "a hold with an empty diff (a held link): red, the report, nothing pushed",
      options: { hold: true, stub: { STUB_CHANGED: "" } },
      exitCode: 1,
      committed: false,
      pushAttempted: false,
      says: ["NOT pushed: the writer holds `feat/take-the-module` for review", "Hold for review"],
      saysNot: ["already matches"],
    },
    {
      reason:
        "a diff touching a workflow file: red, the paths and the operator's dispatch, nothing pushed",
      options: {
        stub: {
          STUB_CHANGED:
            ".bun-version\\0.github/workflows/ci.yml\\0.github/workflows/nightly.yml\\0",
        },
      },
      exitCode: 1,
      committed: false,
      pushAttempted: false,
      says: [
        "NOT pushed: the sync changes `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`",
        "sync-repos.yml in Vivswan/repo-platform with `repo=<owner>/<name>` and `branch=feat/take-the-module`",
      ],
      saysNot: [APPROVAL],
    },
    {
      reason:
        "unchanged on the sync's own commit (a relabel queued behind the push): green, the hedged approval line",
      options: { stub: { STUB_CHANGED: "", STUB_AUTHOR: SYNC_IDENTITY.name } },
      exitCode: 0,
      committed: false,
      pushAttempted: false,
      says: ["already matches it, nothing pushed", RELABEL_APPROVAL],
      saysNot: [APPROVAL],
    },
    {
      reason:
        "unchanged on a human's commit: green, no approval line (the human's own run judged it)",
      options: { stub: { STUB_CHANGED: "", STUB_AUTHOR: "Vivswan" } },
      exitCode: 0,
      committed: false,
      pushAttempted: false,
      says: ["already matches it, nothing pushed"],
      saysNot: [RELABEL_APPROVAL, APPROVAL],
    },
    {
      reason: "files written: green, the commit pushed, the approval line, then the report",
      options: { stub: { STUB_CHANGED: ".bun-version\\0.github/settings.yml\\0" } },
      exitCode: 0,
      committed: true,
      pushAttempted: true,
      says: [`pushed onto \`feat/take-the-module\` as ${PUSHED}`, APPROVAL, "Hold for review: no"],
      saysNot: ["NOT pushed"],
    },
    {
      reason: "a refused push: red, git's own words, the label offered again",
      options: { stub: { STUB_CHANGED: ".bun-version\\0", STUB_PUSH_FAIL: "1" } },
      exitCode: 1,
      committed: true,
      pushAttempted: true,
      says: [
        "NOT pushed: the push onto `feat/take-the-module` was refused",
        PUSH_REFUSAL,
        `add the \`${SYNC_LABEL}\` label again`,
      ],
      saysNot: [APPROVAL],
    },
  ])("$reason", ({ options, exitCode, committed, pushAttempted, says, saysNot }) => {
    const result = run(options);
    expect({
      exitCode: result.exitCode,
      labelRemovalAsked: result.labelRemovalAsked,
      committed: result.committed,
      pushAttempted: result.pushAttempted,
      commentCall: result.commentCall,
      said: says.filter((text) => result.comment?.includes(text)),
      saidNot: saysNot.filter((text) => result.comment?.includes(text)),
      firstLine: result.comment?.split("\n")[0],
    }).toEqual({
      exitCode,
      labelRemovalAsked: true,
      committed,
      pushAttempted,
      commentCall: `POST ${COMMENTS}`,
      said: says,
      saidNot: [],
      firstLine: "<!-- repo-platform sync-branch -->",
    });
  });

  // The same tree the operator's delivery test drives: a path the branch's own .gitignore covers, a bracketed path
  // (itself, not the sibling its glob form matches), and a rung's reported edit reach the pushed commit; a summary
  // row git cannot find fails the run before any comment.
  test("over a real checkout, the ignored file, the bracketed file, and the rung's edit are in the pushed commit", () => {
    const result = run({ written: (root) => writtenTree(root, BUILD) });
    const commit = fixtureGit(result.target, ["rev-parse", "HEAD"]);
    expect({
      exitCode: result.exitCode,
      diff: committedDiff(result.target),
      subject: fixtureGit(result.target, ["log", "-1", "--format=%s"]),
      said: result.comment?.includes(`pushed onto \`${BRANCH}\` as ${commit}`),
      stdout: result.stdout.trim(),
    }).toEqual({
      exitCode: 0,
      diff: WRITTEN_DIFF,
      subject: prTitle(BUILD),
      said: true,
      stdout: `build ${BUILD} pushed onto ${BRANCH} as ${commit}`,
    });
  });

  test("over a real checkout, a written row git cannot find fails red with git's line naming the path, nothing committed", () => {
    const result = run({
      written: (root) => {
        const summary = writtenTree(root, BUILD);
        summary.written.push({
          path: MISSING_PATH,
          class: "managed",
          change: "created",
          detail: "",
        });
        return summary;
      },
    });
    expect({
      exitCode: result.exitCode,
      commits: fixtureGit(result.target, ["log", "--format=%s"]),
      error: result.stdout.includes("::error::staging the written paths failed in the checkout"),
      gitLine: result.stderr.includes(MISSING_PATH_LINE),
      comment: result.comment,
    }).toEqual({ exitCode: 1, commits: "base", error: true, gitLine: true, comment: null });
  });

  test("the push carries a lease on the commit checked out, and the sync commit's subject is the operator's", () => {
    const result = run({ stub: { STUB_CHANGED: ".bun-version\\0" } });
    expect({
      lease: result.pushLease,
      subject: result.commitSubject,
      stdout: result.stdout.trim(),
    }).toEqual({
      lease: `--force-with-lease=${BRANCH}:${TIP}`,
      subject: prTitle(BUILD),
      stdout: `build ${BUILD} pushed onto ${BRANCH} as ${PUSHED}`,
    });
  });

  // The label's removal is read by its status. Read off gh's stderr for "HTTP 404", an outage whose message quoted a
  // 404 passed for "already off", and the run went on to push with the label never taken off.
  test.each<{ reason: string; label: FakeReply; exitCode: number; commented: boolean }>([
    {
      reason:
        "a 404 is the label already off (a relabel queued behind a run that took it): the run goes on",
      label: { status: 404 },
      exitCode: 0,
      commented: true,
    },
    {
      reason: "a 403 is a refusal: red before any comment",
      label: { status: 403 },
      exitCode: 1,
      commented: false,
    },
    {
      reason:
        "a 502 whose message mentions HTTP 404 is an outage, not a missing label: red before any comment",
      label: { status: 502, body: { message: "upstream answered HTTP 404 for the backend" } },
      exitCode: 1,
      commented: false,
    },
  ])("the label removal: $reason", ({ label, exitCode, commented }) => {
    const result = run({ label, stub: { STUB_CHANGED: "", STUB_AUTHOR: "Vivswan" } });
    expect({ exitCode: result.exitCode, commented: result.comment !== null }).toEqual({
      exitCode,
      commented,
    });
  });

  // What would drift silently: a second finder beside fleet-sync-default's, or one that takes a human's comment for its own.
  test.each([
    {
      name: "an earlier comment of this bot is replaced in place, not joined",
      comments: [[{ id: 3, body: "unrelated", user: { login: BOT_LOGIN } }], [EARLIER_COMMENT]],
      expected: `PATCH repos/${REPOSITORY}/issues/comments/777`,
    },
    {
      name: "a comment opening with the marker under another login is left alone and the bot posts its own",
      comments: [[{ ...EARLIER_COMMENT, user: { login: "vivswan" } }]],
      expected: `POST ${COMMENTS}`,
    },
  ])("$name", ({ comments, expected }) => {
    const result = run({ comments, stub: { STUB_CHANGED: "", STUB_AUTHOR: "Vivswan" } });
    expect(result.commentCall).toBe(expected);
  });
});
