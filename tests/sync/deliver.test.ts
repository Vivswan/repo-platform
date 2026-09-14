import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_CAP,
  boundedReport,
  closedFences,
  failureBody,
  fenceFor,
  prBody,
  prTitle,
  tail,
} from "../../.github/scripts/sync/deliver.ts";
import {
  buildReport,
  holdReasons,
  renderReport,
  type SyncOutcome,
  type SyncReport,
} from "../../.github/scripts/sync/writer/report.ts";
import { FAILURE_ISSUE_TITLE } from "../../actions/shared/platform.ts";
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
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/deliver.ts");
const TARGET = "Vivswan/hidden-server";
const PAT = "ghp_SENTINEL";
const BUILD = "abcdef0123456789abcdef0123456789abcdef01";
const REPORT = "## Sync report\n\n| Build |\n| --- |\n| x |\n";
const PR_URL = `https://github.com/${TARGET}/pull/7`;
const REAL_GIT = Bun.which("git") ?? "git";

// With STUB_REAL_GIT set, every call but the network ones (push, ls-remote) runs the real git over the fixture checkout.
// Like the real gh, the stub refuses `--slurp` beside `--jq` before any request.
const GIT_LINES = [
  'printf "git %s\\n" "$*" >>"$STUB_SEQUENCE"',
  'if [ -n "${STUB_REAL_GIT:-}" ]; then case " $* " in *" push "*|*" ls-remote "*) ;; *) exec "$STUB_REAL_GIT" "$@" ;; esac; fi',
  'case "$*" in',
  '  *" add -f -- "*) if [ "${STUB_ADD_FAIL:-}" = 1 ]; then echo "fatal: unable to stage" >&2; exit 128; fi ;;',
  '  *" diff --cached --name-only -z --no-renames") if [ -n "${STUB_DIRTY:-}" ]; then printf "x\\0"; fi ;;',
  '  *" rev-parse HEAD") echo "${STUB_HEAD_SHA:-}" ;;',
  '  *" symbolic-ref HEAD") case "${STUB_HEAD:-refs/heads/main}" in',
  '    error) echo "fatal: not a git repository: target" >&2; exit 128 ;;',
  '    detached) echo "fatal: ref HEAD is not a symbolic ref" >&2; exit 128 ;;',
  "    empty) ;;",
  '    *) echo "${STUB_HEAD:-refs/heads/main}" ;;',
  "  esac ;;",
  '  *" ls-remote "*) if [ -n "${STUB_TIP:-}" ]; then printf "%s\\trefs/heads/automation/repo-platform\\n" "$STUB_TIP"; fi ;;',
  '  *" push "*) if [ "${STUB_PUSH_FAIL:-}" = 1 ]; then echo "fatal: unable to access \'https://x-access-token:${STUB_PAT}@github.com/o/r.git/\': 403" >&2; exit 1; fi ;;',
  "esac",
];
const GH_LINES = [
  'printf "gh %s\\n" "$*" >>"$STUB_SEQUENCE"',
  'if [[ " $* " == *" --slurp "* && ( " $* " == *" --jq "* || " $* " == *" -q "* || " $* " == *" --template "* || " $* " == *" -t "* ) ]]; then echo "the \\`--slurp\\` option is not supported with \\`--jq\\` or \\`--template\\`" >&2; exit 1; fi',
  'case "$*" in',
  '  "${STUB_GH_FAIL:-<none>}"*) echo "gh: HTTP 502" >&2; exit 1 ;;',
  '  "api user "*) echo token-bot ;;',
  '  *"/issues --method GET"*) printf "%s" "${STUB_ISSUE:-}" ;;',
  '  *"/issues --method POST"*|*"/issues/"*" --method PATCH"*) if [ "${STUB_ISSUE_FAIL:-}" = 1 ]; then echo "gh: Forbidden (HTTP 403)" >&2; exit 1; fi ;;',
  '  "pr list "*) if [ -n "${STUB_PR_LIST:-}" ]; then printf "%s" "$STUB_PR_LIST"; elif [ -n "${STUB_PR:-}" ]; then printf \'[{"number":%s,"isCrossRepository":false}]\' "$STUB_PR"; else echo "[]"; fi ;;',
  '  "pr view "*) echo "${STUB_ARMED:-false}" ;;',
  `  "pr create "*) echo "${PR_URL}" ;;`,
  "esac",
];

interface Options {
  hold?: boolean;
  manual?: boolean;
  branch?: string;
  public?: boolean;
  writer?: "success" | "failure" | "skipped";
  checkout?: "success" | "failure";
  /** The clone log checkout_target.ts left behind, when any. */
  checkoutLog?: string;
  stub?: Record<string, string>;
  /** Builds a real checkout under the target and answers the writer's summary over it; git then runs for real. */
  written?: (target: string) => SyncReport;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  verdict: string | null;
  log: string;
  git: string[][];
  gh: string[][];
  issueBody: string | null;
  sequence: string[];
  /** The job summary (GITHUB_STEP_SUMMARY), empty unless a branch delivery wrote its report there. */
  summary: string;
  target: string;
}

function run(options: Options = {}): Run {
  const root = temp.dir("deliver-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  const target = join(root, "target");
  mkdirSync(target);
  const summary = options.written?.(target) ?? {
    hold: options.hold ?? false,
    written: [],
    retired: [],
    mirrors: [],
  };
  writeFileSync(join(runnerTemp, "summary.json"), JSON.stringify(summary));
  writeFileSync(join(runnerTemp, "sync.log"), REPORT);
  if (options.checkoutLog !== undefined)
    writeFileSync(join(runnerTemp, "checkout.log"), options.checkoutLog);
  const sequenceFile = join(root, "sequence.log");
  writeFileSync(sequenceFile, "");
  const summaryFile = join(root, "step-summary.md");
  writeFileSync(summaryFile, "");
  let eventPath = "";
  if (options.branch !== undefined) {
    eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify({ inputs: { repo: TARGET, branch: options.branch } }));
  }
  const git = argvStub(root, "git", GIT_LINES);
  const gh = argvStub(root, "gh", GH_LINES);
  const result = boundedSpawnSync(["bun", SCRIPT], {
    cwd: root,
    env: {
      PATH: `${git.bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_STEP_SUMMARY: summaryFile,
      TARGET,
      TARGET_PRIVATE: options.public === true ? "false" : "true",
      TARGET_DIR: target,
      PAT,
      GH_TOKEN: PAT,
      STUB_PAT: PAT,
      STUB_SEQUENCE: sequenceFile,
      BUILD,
      RUN_URL: "https://github.com/Vivswan/repo-platform/actions/runs/1",
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      MANUAL: options.manual === true ? "true" : "false",
      CHECKOUT_OUTCOME: options.checkout ?? "success",
      WRITER_OUTCOME: options.writer ?? "success",
      GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG,
      ...(options.written === undefined ? {} : { STUB_REAL_GIT: REAL_GIT }),
      ...(options.stub ?? {}),
    },
  });
  const verdictFile = join(runnerTemp, "verdict.txt");
  const bodyFile = join(runnerTemp, "failure-issue-body.md");
  return {
    ...result,
    verdict: existsSync(verdictFile) ? readFileSync(verdictFile, "utf-8").trim() : null,
    log: readFileSync(join(runnerTemp, "deliver.log"), "utf-8"),
    git: git.calls(),
    gh: gh.calls(),
    issueBody: existsSync(bodyFile) ? readFileSync(bodyFile, "utf-8") : null,
    sequence: readFileSync(sequenceFile, "utf-8")
      .split("\n")
      .filter((line) => line !== ""),
    summary: readFileSync(summaryFile, "utf-8"),
    target,
  };
}

const calls = (list: string[][], ...lead: string[]) =>
  list.filter((argv) => {
    const words = argv[1] === "-C" ? argv.slice(3) : argv.slice(1);
    return lead.every((word, index) => words[index] === word);
  });
const silent = (result: Run) => {
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
};

describe("deliver.ts", () => {
  const prCommands = (result: Run) => calls(result.gh, "pr").map((argv) => argv[2]);
  const CLOSE = [
    "12",
    "-R",
    TARGET,
    "--delete-branch",
    "--comment",
    `superseded: the target already matches build ${BUILD}`,
  ];

  // A stale sync PR must never merge: an armed one is disarmed BEFORE it is closed, every open one is closed with
  // the reason and its branch deleted, and nothing is pushed, edited, or armed.
  test.each<{ reason: string; stub: Record<string, string>; pr: string[]; close: string[] | null }>(
    [
      { reason: "no open PR: nothing beyond the lookup", stub: {}, pr: ["list"], close: null },
      {
        reason: "an open PR never armed is closed without a disarm call",
        stub: { STUB_PR: "12" },
        pr: ["list", "view", "close"],
        close: CLOSE,
      },
      {
        reason: "an open armed PR is disarmed, then closed as obsolete",
        stub: { STUB_PR: "12", STUB_ARMED: "true" },
        pr: ["list", "view", "merge", "close"],
        close: CLOSE,
      },
    ],
  )("a tree the build already matches is unchanged: $reason", ({ stub, pr, close }) => {
    const result = run({ stub });
    silent(result);
    expect(result.exitCode).toBe(0);
    expect(result.verdict).toBe("unchanged");
    expect(prCommands(result)).toEqual(pr);
    const closes: string[][] = close === null ? [] : [close];
    expect(calls(result.gh, "pr", "close").map((argv) => argv.slice(3))).toEqual(closes);
    expect(calls(result.git, "push")).toEqual([]);
    expect(result.gh.some((argv) => argv[4] === "POST" || argv.includes("--auto"))).toBe(false);
    const disarmAt = result.sequence.findIndex((line) => line.includes("--disable-auto"));
    const closeAt = result.sequence.findIndex((line) => line.startsWith("gh pr close"));
    expect(disarmAt >= 0).toBe(pr.includes("merge"));
    if (disarmAt >= 0) expect(closeAt).toBeGreaterThan(disarmAt);
    if (close !== null) expect(result.log).toContain("closed the obsolete sync pull request #12");
  });

  // GitHub's `gh pr list --head` matches a fork's branch of the same name, so a fork could impersonate the sync PR:
  // the listing asks isCrossRepository and only the target's own PR is viewed, closed, or refreshed.
  test.each<{ reason: string; stub: Record<string, string>; verdict: string; pr: string[] }>([
    {
      reason:
        "beside the target's own PR, the fork's is skipped and the target's is the one closed",
      stub: {
        STUB_PR_LIST: JSON.stringify([
          { number: 9, isCrossRepository: true },
          { number: 12, isCrossRepository: false },
        ]),
        STUB_ARMED: "true",
      },
      verdict: "unchanged",
      pr: ["list", "view", "merge", "close"],
    },
    {
      reason: "alone, it is no sync PR: a change opens the target's own",
      stub: {
        STUB_DIRTY: "1",
        STUB_PR_LIST: JSON.stringify([{ number: 9, isCrossRepository: true }]),
      },
      verdict: "opened",
      pr: ["list", "create", "merge"],
    },
  ])("a fork's PR from a same-named branch, $reason", ({ stub, verdict, pr }) => {
    const result = run({ stub });
    silent(result);
    expect(result.verdict).toBe(verdict);
    expect(calls(result.gh, "pr", "list")[0]).toContain("number,isCrossRepository");
    expect(prCommands(result)).toEqual(pr);
    for (const argv of calls(result.gh, "pr", "view").concat(calls(result.gh, "pr", "close"))) {
      expect(argv[3]).toBe("12");
    }
    expect(result.sequence.some((line) => line.includes(" 9 "))).toBe(false);
  });

  // The must() chain fails closed at each gh call with its own reason, nothing runs after it, and a non-JSON answer
  // from gh is a failure too, never a crash.
  test.each<{ reason: string; stub: Record<string, string>; failure: string; last: string }>([
    ...(
      [
        ["pr list", "listing the sync pull request failed"],
        ["pr view", "reading the sync pull request's auto-merge state failed"],
        ["pr merge", "disarming the sync pull request's auto-merge failed"],
        ["pr close", "closing the obsolete sync pull request failed"],
      ] as const
    ).map(([command, failure]) => ({
      reason: `gh ${command} fails`,
      stub: { STUB_PR: "12", STUB_ARMED: "true", STUB_GH_FAIL: command },
      failure,
      last: `gh ${command}`,
    })),
    {
      reason: "gh pr list answers non-JSON",
      stub: { STUB_PR_LIST: "not json" },
      failure: "listing the sync pull request failed",
      last: "gh pr list",
    },
  ])(
    "an unchanged tree whose obsolete-PR cleanup fails ($reason) files the failure and stops there",
    ({ stub, failure, last }) => {
      const result = run({ stub });
      silent(result);
      expect(result.verdict).toBe("failed");
      expect(result.issueBody).toContain(failure);
      const prLines = result.sequence.filter((line) => line.startsWith("gh pr"));
      expect(prLines.at(-1)?.startsWith(last)).toBe(true);
    },
  );

  // The push authenticates alone (the checkout kept no token) under a lease, so a concurrent writer fails loudly;
  // squash is the fleet's merge method; the token must reach neither the log nor the body; and a manual run never
  // arms auto-merge, since the operator asked to look.
  test.each<{ manual: boolean; merge: string[][]; log: string | null }>([
    { manual: false, merge: [["7", "-R", TARGET, "--squash", "--auto"]], log: null },
    { manual: true, merge: [], log: "manual run" },
  ])(
    "a clean change opens the PR whose body carries the report (manual: $manual)",
    ({ manual, merge, log }) => {
      const result = run({ manual, stub: { STUB_DIRTY: "1" } });
      silent(result);
      expect(result.verdict).toBe("opened");
      expect(result.git.map((argv) => argv.slice(3, 5).join(" "))).toContain("commit -q");
      const push = calls(result.git, "push")[0];
      expect(push).toContain("--force-with-lease=automation/repo-platform:");
      expect(push).toContain(`https://x-access-token:${PAT}@github.com/${TARGET}.git`);
      const create = calls(result.gh, "pr", "create")[0];
      expect(create.slice(create.indexOf("--base"), create.indexOf("--base") + 2)).toEqual([
        "--base",
        "main",
      ]);
      const body = readFileSync(create[create.indexOf("--body-file") + 1], "utf-8");
      expect(body).toContain(`build \`${BUILD}\``);
      expect(body).toContain(REPORT.trimEnd());
      expect(calls(result.gh, "pr", "merge").map((argv) => argv.slice(3))).toEqual(merge);
      if (log !== null) expect(result.log).toContain(log);
      expect(result.log).not.toContain(PAT);
      expect(body).not.toContain(PAT);
      expect(result.summary).toBe("");
    },
  );

  // The branch path: the module PR's own branch gets the files, so no sync PR, no auto-merge, and the failure issue is
  // neither closed nor consulted; the report the PR body would carry goes to the job summary instead.
  describe("a dispatched branch", () => {
    const BRANCH = "feat/add-site";
    const TIP = "2222222222222222222222222222222222222222";
    const onBranch = { STUB_HEAD: `refs/heads/${BRANCH}`, STUB_HEAD_SHA: TIP };

    test("a change is one commit on the checkout's branch, pushed with a lease on the cloned tip, with no gh call at all", () => {
      const result = run({ branch: BRANCH, public: true, stub: { ...onBranch, STUB_DIRTY: "1" } });
      silent(result);
      expect(result.exitCode).toBe(0);
      expect(result.verdict).toBe("pushed");
      expect(result.gh).toEqual([]);
      expect(calls(result.git, "checkout")).toEqual([]);
      expect(result.git.map((argv) => argv[3])).toEqual([
        "config",
        "config",
        "add",
        "diff",
        "symbolic-ref",
        "rev-parse",
        "commit",
        "push",
      ]);
      const push = calls(result.git, "push")[0];
      expect(push.slice(3)).toEqual([
        "push",
        "--quiet",
        `--force-with-lease=${BRANCH}:${TIP}`,
        `https://x-access-token:${PAT}@github.com/${TARGET}.git`,
        `HEAD:refs/heads/${BRANCH}`,
      ]);
      expect(result.log).not.toContain(PAT);
      expect(result.summary).toContain(`Build \`${BUILD}\` pushed onto \`${BRANCH}\``);
      expect(result.summary).toContain(REPORT.trimEnd());
      // The masker holds the name: a spelled one would render as `***` in the summary, the run link's included on a self-sync.
      expect(result.summary).not.toContain("hidden-server");
      expect(result.summary).not.toContain("repo-platform/actions");
    });

    test("a private target's summary withholds the report and the branch: both are the repository's own", () => {
      const result = run({ branch: BRANCH, stub: { ...onBranch, STUB_DIRTY: "1" } });
      expect(result.verdict).toBe("pushed");
      expect(result.summary).toContain("withheld");
      expect(result.summary).not.toContain(BRANCH);
      expect(result.summary).not.toContain(TARGET);
      expect(result.summary).not.toContain("| x |");
    });

    test("a branch already matching the build is unchanged, and no PR or issue is looked up", () => {
      const result = run({ branch: BRANCH, stub: onBranch });
      silent(result);
      expect(result.verdict).toBe("unchanged");
      expect(result.gh).toEqual([]);
      expect(calls(result.git, "push")).toEqual([]);
      expect(result.summary).toBe("");
    });

    test("a refused branch push files the failure issue, as every delivery failure does", () => {
      const result = run({
        branch: BRANCH,
        stub: { ...onBranch, STUB_DIRTY: "1", STUB_PUSH_FAIL: "1" },
      });
      silent(result);
      expect(result.verdict).toBe("failed");
      expect(result.issueBody).toContain("pushing the branch failed");
      expect(result.issueBody).not.toContain(PAT);
      expect(result.summary).toBe("");
    });
  });

  // A target whose own .gitignore covers a managed path (an excepted, ignored .bun-version whose exception the PR
  // removes): `git add --all` skipped it, the run went green with the manifest naming a file the commit lacked, and
  // the validator went red on the target's next PR. The commit changes exactly the rows the summary says changed on
  // disk (a released record's absent file is not asked of git), and a row naming a path git cannot find fails the run.
  test.each<{
    reason: string;
    written: (target: string) => SyncReport;
    verdict: string;
    diff: string[] | null;
    issue: string[];
  }>([
    {
      reason: "the ignored file is in the commit beside the manifest that names it",
      written: (target) => writtenTree(target, BUILD),
      verdict: "opened",
      diff: WRITTEN_DIFF,
      issue: [],
    },
    {
      reason: "a written row git cannot find fails the delivery with git's line naming the path",
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
      verdict: "failed",
      diff: null,
      issue: ["staging the written paths failed in the checkout", MISSING_PATH_LINE],
    },
  ])("over a real checkout, $reason", ({ written, verdict, diff, issue }) => {
    const result = run({ written });
    silent(result);
    expect(result.verdict).toBe(verdict);
    if (diff === null) {
      expect(fixtureGit(result.target, ["log", "--format=%s"])).toBe("base");
    } else {
      expect(committedDiff(result.target)).toEqual(diff);
      expect(fixtureGit(result.target, ["log", "-1", "--format=%s"])).toBe(prTitle(BUILD));
      expect(fixtureGit(result.target, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/automation/repo-platform",
      );
    }
    for (const text of issue) expect(result.issueBody).toContain(text);
  });

  // The incoming revision may need review, so an armed PR is disarmed before the branch moves under it, and the
  // base follows the checkout's branch (a renamed default branch). Drifted, auto-merge would fire on an unreviewed hold.
  test("an existing armed PR is disarmed before the push, refreshed onto the checkout's branch, and left disarmed when the report holds", () => {
    const result = run({
      hold: true,
      stub: {
        STUB_DIRTY: "1",
        STUB_TIP: "0123456789012345678901234567890123456789",
        STUB_PR: "12",
        STUB_ARMED: "true",
      },
    });
    silent(result);
    expect(result.verdict).toBe("refreshed");
    const disarmAt = result.sequence.findIndex((line) => line.includes("--disable-auto"));
    const pushAt = result.sequence.findIndex((line) => / push /.test(line));
    expect(disarmAt).toBeGreaterThanOrEqual(0);
    expect(pushAt).toBeGreaterThan(disarmAt);
    expect(calls(result.git, "push")[0]).toContain(
      "--force-with-lease=automation/repo-platform:0123456789012345678901234567890123456789",
    );
    expect(calls(result.gh, "pr", "edit")[0].slice(3, 8)).toEqual([
      "12",
      "-R",
      TARGET,
      "--base",
      "main",
    ]);
    expect(result.gh.some((argv) => argv.includes("--auto"))).toBe(false);
    expect(result.log).toContain("holds the PR for review");
  });

  // A failed step still ends the row with a verdict and an issue carrying that step's own log (the writer's report,
  // the checkout's clone log); nothing is committed or pushed, and a failed clone's directory is not asked anything.
  test.each<{
    reason: string;
    options: Options;
    says: string[];
    gitAsked: boolean;
  }>([
    {
      reason: "a failed writer",
      options: { writer: "failure" },
      says: ["the writer exited with an error", REPORT.trimEnd()],
      gitAsked: true,
    },
    {
      reason: "a failed checkout",
      options: {
        checkout: "failure",
        writer: "skipped",
        checkoutLog: "$ git clone -> exit 128\nfatal: could not read from remote\n",
      },
      says: ["the target checkout failed", "## Checkout log", "fatal: could not read from remote"],
      gitAsked: false,
    },
  ])(
    "$reason files the issue with its log and records the failed verdict, touching no tree",
    ({ options, says, gitAsked }) => {
      const result = run(options);
      silent(result);
      expect(result.exitCode).toBe(0);
      expect(result.verdict).toBe("failed");
      const create = result.gh.find((argv) => argv[4] === "POST");
      expect(create?.slice(1, 5)).toEqual(["api", `repos/${TARGET}/issues`, "--method", "POST"]);
      expect(create).toContain(`title=${FAILURE_ISSUE_TITLE}`);
      for (const line of says) expect(result.issueBody).toContain(line);
      expect(calls(result.git, "commit")).toEqual([]);
      expect(calls(result.git, "push")).toEqual([]);
      if (!gitAsked) expect(result.git).toEqual([]);
    },
  );

  // symbolic-ref, not rev-parse --abbrev-ref: a tag named main answers heads/main under the latter. A ref outside
  // refs/heads/, an empty answer, and a git error are all refused with git's own words in the report, and every
  // git failure before the commit files with its reason and stops there.
  test.each<{
    read: string;
    stub: Record<string, string>;
    reason: string;
    logged: string;
    git: string[];
  }>([
    {
      read: "fails at git add",
      stub: { STUB_ADD_FAIL: "1" },
      reason: "staging the written paths failed in the checkout",
      logged: "$ git add -> exit 128\nfatal: unable to stage",
      git: ["config", "config", "add"],
    },
    {
      read: "errors",
      stub: { STUB_HEAD: "error" },
      reason: "git symbolic-ref failed in the target",
      logged: "$ git symbolic-ref -> exit 128\nfatal: not a git repository: target",
      git: ["config", "config", "add", "diff", "symbolic-ref"],
    },
    {
      read: "finds HEAD detached",
      stub: { STUB_HEAD: "detached" },
      reason: "git symbolic-ref failed in the target",
      logged: "$ git symbolic-ref -> exit 128\nfatal: ref HEAD is not a symbolic ref",
      git: ["config", "config", "add", "diff", "symbolic-ref"],
    },
    {
      read: "answers a ref outside refs/heads/",
      stub: { STUB_HEAD: "refs/remotes/origin/main" },
      reason: "the target checkout is not on a branch",
      logged: "$ git symbolic-ref -> exit 0",
      git: ["config", "config", "add", "diff", "symbolic-ref"],
    },
    {
      read: "answers nothing on exit 0",
      stub: { STUB_HEAD: "empty" },
      reason: "the target checkout is not on a branch",
      logged: "$ git symbolic-ref -> exit 0",
      git: ["config", "config", "add", "diff", "symbolic-ref"],
    },
  ])(
    "a checkout whose branch read $read files that failure, with git's words, before any branch or commit",
    ({ stub, reason, logged, git }) => {
      const result = run({ stub: { STUB_DIRTY: "1", ...stub } });
      silent(result);
      expect(result.verdict).toBe("failed");
      expect(result.issueBody).toContain(
        `The repo-platform sync for this repository failed: ${reason}.`,
      );
      expect(result.issueBody).toContain(`## Delivery log\n\n\`\`\`\`text\n`);
      expect(result.issueBody).toContain(`${logged}\nfiling the failure report: ${reason}`);
      expect(result.git.map((argv) => argv[3])).toEqual(git);
    },
  );

  // git prints the token URL in its 403; the redaction is the one thing between the PAT and a public issue body.
  test("a refused push files the issue with git's redacted error and reopens an existing report", () => {
    const result = run({
      stub: { STUB_DIRTY: "1", STUB_PUSH_FAIL: "1", STUB_ISSUE: "41 closed" },
    });
    silent(result);
    expect(result.verdict).toBe("failed");
    const patch = result.gh.find((argv) => argv[2] === `repos/${TARGET}/issues/41`);
    expect(patch).toContain("state=open");
    expect(result.issueBody).toContain("pushing the automation branch failed");
    expect(result.issueBody).toContain("https://***@github.com/o/r.git");
    expect(result.issueBody).not.toContain(PAT);
    expect(result.log).not.toContain(PAT);
  });

  // GitHub lists issues created-ascending across pages; the open report is the one being watched, so it outranks
  // an older closed one, whether the delivery closes it or reopens it.
  test.each<{
    reason: string;
    stub: Record<string, string>;
    issues: string;
    verdict: string;
    patches: string[][];
  }>([
    {
      reason: "a clean delivery closes the one open report",
      stub: {},
      issues: "41 open",
      verdict: "opened",
      patches: [["41", "state=closed"]],
    },
    {
      reason: "a clean delivery",
      stub: {},
      issues: "8 closed\n12 open\n",
      verdict: "opened",
      patches: [["12", "state=closed"]],
    },
    {
      reason: "a failed delivery",
      stub: { STUB_PUSH_FAIL: "1" },
      issues: "8 closed\n12 open\n",
      verdict: "failed",
      patches: [["12", "state=open"]],
    },
  ])(
    "$reason addresses the open failure report, never the older closed one",
    ({ stub, issues, verdict, patches }) => {
      const result = run({ stub: { STUB_DIRTY: "1", ...stub, STUB_ISSUE: issues } });
      silent(result);
      expect(result.verdict).toBe(verdict);
      expect(
        result.gh
          .filter((argv) => argv[1] === "api" && argv[4] === "PATCH")
          .map((argv) => [argv[2], argv.find((word) => word.startsWith("state="))]),
      ).toEqual(patches.map(([number, state]) => [`repos/${TARGET}/issues/${number}`, state]));
    },
  );

  // The failed verdict is written only once the issue exists; otherwise verdict.ts's row step goes red instead of
  // reading a stale verdict as a delivery.
  test("a failure the target cannot take (the issue write refused) leaves no verdict and exits red", () => {
    const result = run({ writer: "failure", stub: { STUB_ISSUE_FAIL: "1" } });
    silent(result);
    expect(result.exitCode).toBe(1);
    expect(result.verdict).toBeNull();
  });
});

describe("failureBody", () => {
  // CommonMark: a fence closes on a run at least as long, so each fence must exceed the longest run the log quotes.
  test("fences each log tail past its longest backtick run and skips empty logs", () => {
    const body = failureBody({
      runUrl: "u",
      build: BUILD,
      reason: "r",
      checkoutLog: "",
      syncLog: "a ````` b\n",
      deliverLog: "",
    });
    expect(body).toContain("``````text\na ````` b\n``````");
    expect(body).not.toContain("Delivery log");
    expect(body).not.toContain("Checkout log");
    expect(fenceFor("none")).toBe("````");
  });

  // The failure issue carries the END of a long log, where git and the writer put their last words; keeping the
  // head instead would drop the diagnostic and the issue would still read as complete.
  test("tail keeps the last bytes of a long log and says how much it dropped", () => {
    const dir = temp.dir("deliver-tail-");
    const file = join(dir, "log");
    writeFileSync(file, `${"x".repeat(50)}END`);
    expect(tail(file, 10)).toBe("... (43 earlier bytes not shown)\nxxxxxxxEND");
    expect(tail(join(dir, "missing"))).toBe("");
  });
});

describe("closedFences", () => {
  // CommonMark's closing rule, which the cut relies on: a run at least as long, alone on its line, no info string.
  test.each([
    { text: "```\nx", closed: "```\nx\n```", reason: "a three-backtick fence left open" },
    {
      text: "````diff\n ```\nx",
      closed: "````diff\n ```\nx\n````",
      reason: "a four-backtick fence: the quoted three cannot close it",
    },
    { text: "```\nx\n```", closed: "```\nx\n```", reason: "a closed fence" },
    {
      text: "```\nx\n```diff",
      closed: "```\nx\n```diff\n```",
      reason: "a run carrying an info string does not close",
    },
    { text: "no fence", closed: "no fence", reason: "no fence" },
  ])("$reason", ({ text, closed }) => {
    expect(closedFences(text)).toBe(closed);
  });
});

describe("boundedReport", () => {
  const review =
    "\n### Review\n\nHold for review: **yes**\n\n- local edits replaced in README.md\n";
  const MARKER = "\n\n> [!WARNING]\n> ";
  const CUT = / characters of this section were cut to fit GitHub's body limit\.\n/;
  const omitted = (text: string) =>
    [...text.matchAll(/> (\d+) characters of this section were cut/g)].map((m) => Number(m[1]));
  const longLine = `+${"x".repeat(70_000)}`;
  const longDiff = `## Sync report\n\n### Replaced local edits\n\n\`\`\`diff\n${longLine}\n\`\`\``;

  // GitHub refuses a body past 65,536 characters after the branch is pushed, so the report is cut on a line
  // boundary; the marker and the Review section must render as Markdown, so the fence is closed first. A report
  // under the cap is untouched (the control).
  test("a report over the cap is cut on a line boundary, its Review section kept whole", () => {
    expect(boundedReport(`## Sync report\n${review}`)).toBe(`## Sync report\n${review}`);
    const report = `${longDiff}${review}`;
    const bounded = boundedReport(report);
    expect(bounded.length).toBeLessThanOrEqual(BODY_CAP);
    expect(bounded.startsWith("## Sync report\n\n### Replaced local edits")).toBe(true);
    expect(bounded).not.toContain(longLine);
    expect(bounded).toContain("```diff\n```\n\n> [!WARNING]");
    expect(omitted(bounded)).toEqual([`\n${longLine}\n\`\`\``.length]);
    expect(bounded.endsWith(review)).toBe(true);
    const body = prBody({ operator: "o/r", build: BUILD, runUrl: "u", report });
    expect(body.length).toBeLessThan(65_536);
  });

  // The ranking: the Review section takes its room first, then the tables and notes, then the diffs; a section
  // with no room left leaves no trace rather than a dangling heading, and one marker stands for each cut section.
  const reasons = (count: number) =>
    Array.from({ length: count }, (_, i) => `- mirror skills/${i}/LICENSE.md refused`).join("\n");
  const header = "## Sync report\n";
  const written = "\n### Written\n\n| Path |\n| --- |\n| `a` |\n";
  const replaced = `\n### Replaced local edits\n\n\`\`\`diff\n${"+d\n".repeat(200)}\`\`\`\n`;
  const retired = `\n### Retired\n\n| Path |\n| --- |\n${"| `r` |\n".repeat(20)}`;
  const bigReview = `\n### Review\n\nHold for review: **yes**\n\n${reasons(1_750)}\n`;
  test.each<{
    reason: string;
    report: string;
    cap: number;
    head: string;
    tail: string | RegExp;
    present: string[];
    absent: string[];
    /** The exact count the one marker accounts for, when the cut section's kept prefix can be read back. */
    accounted?: (bounded: string) => number;
  }>([
    {
      reason:
        "an oversized Review section behind an oversized diff keeps its heading and leading reasons; the diff leaves no trace",
      report: `${longDiff}${bigReview}`,
      cap: BODY_CAP,
      head: header,
      tail: CUT,
      present: [
        "\n### Review\n\nHold for review: **yes**\n\n- mirror skills/0/LICENSE.md refused\n",
        "- mirror skills/1000/LICENSE.md refused\n",
      ],
      absent: [longLine, "Replaced local edits"],
    },
    {
      reason: "the tables and notes take their room before the diffs when both cannot fit",
      report: `${header}${written}${replaced}${retired}${review}`,
      cap: header.length + written.length + retired.length + review.length + 200,
      head: `${header}${written}\n### Replaced local edits\n\n\`\`\`diff\n+d\n`,
      tail: `${retired}${review}`,
      present: [],
      absent: [],
      // The kept lines, the closing fence, and the marker are all that stand for the diff section, and the marker
      // accounts for the rest of it.
      accounted: (bounded) => {
        const section = bounded.slice(
          header.length + written.length,
          -(retired.length + review.length),
        );
        const kept = section.slice(0, section.indexOf(MARKER)).replace(/\n```$/, "");
        expect(replaced.startsWith(kept)).toBe(true);
        return replaced.length - kept.length;
      },
    },
    {
      reason: "a Review section that alone exceeds the cap is cut too",
      report: `## Sync report\n\n### Review\n\nHold for review: **yes**\n\n${reasons(3000)}\n`,
      cap: BODY_CAP,
      head: "## Sync report\n\n### Review\n\nHold for review: **yes**",
      tail: CUT,
      present: [],
      absent: [],
    },
  ])("$reason", ({ report, cap, head, tail, present, absent, accounted }) => {
    expect(report.length).toBeGreaterThan(cap);
    const bounded = boundedReport(report, cap);
    expect(bounded.length).toBeLessThanOrEqual(cap);
    expect(bounded.startsWith(head)).toBe(true);
    if (typeof tail === "string") expect(bounded.endsWith(tail)).toBe(true);
    else expect(bounded).toMatch(new RegExp(`${tail.source}$`));
    for (const text of present) expect(bounded).toContain(text);
    for (const text of absent) expect(bounded).not.toContain(text);
    expect(omitted(bounded)).toHaveLength(1);
    if (accounted !== undefined) expect(omitted(bounded)).toEqual([accounted(bounded)]);
  });

  // Cross-file with report.ts: the section split on "\n### " and the REVIEW_HEADING and REPLACED_HEADING
  // constants must match renderReport's headings, and the hold reasons (what the reviewer reads) survive any cut.
  test("a rendered report keeps every hold reason, table, and note whole; only the diffs are cut", () => {
    const outcome: SyncOutcome = {
      build: BUILD,
      modules: ["bun"],
      private: false,
      written: Array.from({ length: 40 }, (_, i) => ({
        path: `docs/page-${i}.md`,
        class: "managed",
        change: "updated",
        detail: "",
      })),
      replaced: Array.from({ length: 3 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        diff: `--- src/file-${i}.ts\n+++ src/file-${i}.ts\n@@\n-${"y".repeat(30_000)}\n+${"z".repeat(30_000)}`,
      })),
      retired: [{ path: "old.yml", outcome: "held", detail: "edited locally" }],
      notes: ["unknown module dropped: unknown-one"],
      mirrors: [],
    };
    const report = renderReport(buildReport(outcome));
    expect(report.length).toBeGreaterThan(BODY_CAP);
    const bounded = boundedReport(report);
    expect(bounded.length).toBeLessThanOrEqual(BODY_CAP);
    for (const reason of holdReasons(outcome)) expect(bounded).toContain(`- ${reason}\n`);
    for (const row of outcome.written) {
      expect(bounded).toContain(`| \`${row.path}\` | managed | updated |`);
    }
    expect(bounded).toContain("| `old.yml` | held | edited locally |");
    expect(bounded).toContain("- unknown module dropped: unknown-one");
    expect(bounded).toContain("#### `src/file-0.ts`");
    expect(bounded).not.toContain("z".repeat(30_000));
    expect(omitted(bounded)).toHaveLength(1);
    expect(omitted(bounded)[0]).toBeGreaterThan(report.length - BODY_CAP);
  });

  // The exhaustive sweep over every cap: a half heading or a dangling heading is exactly the silent drift a
  // boundary bug produces, and this is the case that holds the Review-first ranking.
  test("a cut section keeps its whole heading line or leaves no trace, at every cap", () => {
    const wide = `\n### Written\n\n| Path |\n| --- |\n${"| `a` |\n".repeat(30)}`;
    const report = `${header}${wide}${review}`;
    const seen = { dropped: 0, headed: 0 };
    for (let cap = header.length + review.length; cap < report.length; cap++) {
      const bounded = boundedReport(report, cap);
      expect(bounded.length).toBeLessThanOrEqual(cap);
      expect(bounded.startsWith(header)).toBe(true);
      expect(bounded.endsWith(review)).toBe(true);
      if (bounded === `${header}${review}`) seen.dropped++;
      else {
        expect(bounded.startsWith(`${header}\n### Written\n`)).toBe(true);
        expect(omitted(bounded)).toHaveLength(1);
        seen.headed++;
      }
    }
    expect(seen.dropped).toBeGreaterThan(0);
    expect(seen.headed).toBeGreaterThan(0);
  });

  // Cross-file with report.ts fencedDiff (one backtick longer than any quoted run) against deliver.ts openFence:
  // three backticks would leave the marker and the Review section rendering as code.
  test("a cut inside a four-backtick fence (a diff quoting a fence line) is closed with four backticks", () => {
    const outcome: SyncOutcome = {
      build: BUILD,
      modules: ["bun"],
      private: false,
      written: [],
      replaced: [
        {
          path: "README.md",
          diff: `--- README.md\n+++ README.md\n@@\n \`\`\`\n-old\n+${"x".repeat(70_000)}\n \`\`\``,
        },
      ],
      retired: [],
      notes: [],
      mirrors: [],
    };
    const report = renderReport(buildReport(outcome));
    expect(report).toContain("````diff\n");
    const bounded = boundedReport(report);
    expect(bounded.length).toBeLessThanOrEqual(BODY_CAP);
    expect(bounded).toContain("@@\n ```\n-old\n````\n\n> [!WARNING]");
    expect(bounded.endsWith(review)).toBe(true);
  });
});
