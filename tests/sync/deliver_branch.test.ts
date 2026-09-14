// The branch delivery's contract with the human reading the pull request (docs/sync.md, "Syncing a branch by label"),
// driven as the workflow drives it: the script spawned over git and gh stubs, one row per outcome. What would drift
// silently: the label staying on after a failure, a hold or a workflow-file diff reaching the push, a queued relabel
// losing the approval line, a refused push reported without git's own words.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SYNC_IDENTITY } from "../../.github/scripts/shared/git_identity.ts";
import { prTitle } from "../../.github/scripts/sync/deliver.ts";
import type { SyncReport } from "../../.github/scripts/sync/writer/report.ts";
import { SYNC_LABEL } from "../../actions/shared/platform.ts";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { FIXTURE_GITCONFIG, fixtureGit } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";
import {
  committedDiff,
  MISSING_PATH,
  MISSING_PATH_LINE,
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

// The build checkout answers its commit; the target checkout answers what each row stages (NUL-separated paths),
// the tip's author, and the commit before and after the sync commit. With STUB_REAL_GIT set, every target call but
// the push runs the real git over the fixture checkout.
const GIT_LINES = [
  'if [ -n "${STUB_REAL_GIT:-}" ]; then case "$*" in "-C target "*) case " $* " in *" push "*) ;; *) exec "$STUB_REAL_GIT" "$@" ;; esac ;; esac; fi',
  'case "$*" in',
  `  "-C build rev-parse HEAD") echo "${BUILD}" ;;`,
  '  *" diff --cached --name-only -z --no-renames") printf "%b" "${STUB_CHANGED:-}" ;;',
  '  *" log -1 --format=%an") echo "${STUB_AUTHOR:-}" ;;',
  `  *" rev-parse HEAD") if [ -f "$STUB_COMMITTED" ]; then echo "${PUSHED}"; else echo "${TIP}"; fi ;;`,
  '  *" commit "*) : >"$STUB_COMMITTED" ;;',
  `  *" push "*) if [ "\${STUB_PUSH_FAIL:-}" = 1 ]; then echo "${PUSH_REFUSAL}" >&2; exit 1; fi ;;`,
  "esac",
];
// The comment body travels as `-F body=@<file>`; the stub copies it out so the test reads what GitHub would show.
const GH_LINES = [
  'for a in "$@"; do case "$a" in body=@*) cp "${a#body=@}" "$STUB_COMMENT_OUT" ;; esac; done',
  'case "$*" in',
  `  *" DELETE "*"/labels/"*) case "\${STUB_LABEL:-ok}" in 404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;; fail) echo "gh: Forbidden (HTTP 403)" >&2; exit 1 ;; esac ;;`,
  '  *"/comments --paginate --jq "*) printf "%s" "${STUB_COMMENT_ID:-}" ;;',
  "esac",
];

interface Options {
  migrate?: "success" | "failure";
  writer?: "success" | "failure" | "skipped";
  hold?: boolean;
  stub?: Record<string, string>;
  /** Builds a real checkout under the target and answers the writer's summary over it; git then runs for real. */
  written?: (target: string) => SyncReport;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  target: string;
  labelRemoved: boolean;
  comment: string | null;
  /** The comment call that carried the body: POST creates on the issue, PATCH replaces the found comment by its id. */
  commentMethod: string | null;
  commentEndpoint: string | null;
  committed: boolean;
  /** The `-m` the sync commit was made with, null when no commit was made. */
  commitSubject: string | null;
  pushAttempted: boolean;
  pushLease: string | null;
}

function run(options: Options = {}): Run {
  const root = temp.dir("deliver-branch-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  const target = join(root, "target");
  mkdirSync(target);
  mkdirSync(join(root, "build"));
  const summary = options.written?.(target) ?? {
    hold: options.hold ?? false,
    holdReasons: options.hold === true ? ["replaced local edits in .editorconfig"] : [],
    written: [],
    retired: [],
    mirrors: [],
  };
  writeFileSync(join(runnerTemp, "summary.json"), JSON.stringify(summary));
  writeFileSync(join(runnerTemp, "sync.log"), REPORT);
  const committed = join(root, "committed");
  const commentOut = join(root, "comment.md");
  const git = argvStub(root, "git", GIT_LINES);
  const gh = argvStub(root, "gh", GH_LINES);
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
      MIGRATE_OUTCOME: options.migrate ?? "success",
      WRITER_OUTCOME: options.writer ?? "success",
      STUB_COMMITTED: committed,
      STUB_COMMENT_OUT: commentOut,
      GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG,
      ...(options.written === undefined ? {} : { STUB_REAL_GIT: REAL_GIT }),
      ...(options.stub ?? {}),
    },
  });
  const ghCalls = gh.calls();
  const commentCall = ghCalls.find((call) => call.some((arg) => arg.startsWith("body=@")));
  const gitCalls = git.calls();
  const push = gitCalls.find((call) => call.includes("push"));
  const commit = gitCalls.find((call) => call.includes("commit"));
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    target,
    labelRemoved: ghCalls.some(
      (call) =>
        call.includes("DELETE") &&
        call.at(-1)?.endsWith(`/labels/${encodeURIComponent(SYNC_LABEL)}`) === true,
    ),
    comment: existsSync(commentOut) ? readFileSync(commentOut, "utf-8") : null,
    commentMethod: commentCall?.[commentCall.indexOf("--method") + 1] ?? null,
    commentEndpoint: commentCall?.find((arg) => arg.startsWith("repos/")) ?? null,
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
      labelRemoved: result.labelRemoved,
      committed: result.committed,
      pushAttempted: result.pushAttempted,
      commentMethod: result.commentMethod,
      commentEndpoint: result.commentEndpoint,
      said: says.filter((text) => result.comment?.includes(text)),
      saidNot: saysNot.filter((text) => result.comment?.includes(text)),
      firstLine: result.comment?.split("\n")[0],
    }).toEqual({
      exitCode,
      labelRemoved: true,
      committed,
      pushAttempted,
      commentMethod: "POST",
      commentEndpoint: `repos/${REPOSITORY}/issues/42/comments`,
      said: says,
      saidNot: [],
      firstLine: "<!-- repo-platform sync-branch -->",
    });
  });

  // The same tree the operator's delivery test drives: a path the branch's own .gitignore covers reaches the commit
  // the manifest names it in, and a summary row git cannot find fails the run before any comment.
  test("over a real checkout, the ignored file is in the pushed commit beside the manifest that names it", () => {
    const result = run({ written: (target) => writtenTree(target, BUILD) });
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
      written: (target) => {
        const summary = writtenTree(target, BUILD);
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

  test("a label already off (a relabel queued behind a run that took it) is not a failure; any other refusal is, before any comment", () => {
    const gone = run({ stub: { STUB_CHANGED: "", STUB_AUTHOR: "Vivswan", STUB_LABEL: "404" } });
    const refused = run({ stub: { STUB_CHANGED: "", STUB_LABEL: "fail" } });
    expect({
      gone: { exitCode: gone.exitCode, commented: gone.comment !== null },
      refused: { exitCode: refused.exitCode, commented: refused.comment !== null },
    }).toEqual({
      gone: { exitCode: 0, commented: true },
      refused: { exitCode: 1, commented: false },
    });
  });

  test("an earlier comment of this bot is replaced in place, not joined", () => {
    const result = run({
      stub: { STUB_CHANGED: "", STUB_AUTHOR: "Vivswan", STUB_COMMENT_ID: "777" },
    });
    expect({ method: result.commentMethod, endpoint: result.commentEndpoint }).toEqual({
      method: "PATCH",
      endpoint: `repos/${REPOSITORY}/issues/comments/777`,
    });
  });
});
