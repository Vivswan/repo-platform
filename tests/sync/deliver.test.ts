import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_CAP,
  boundedReport,
  closedFences,
  DELIVERY_CALLS,
  failureBody,
  fenceFor,
  prBody,
  tail,
} from "../../.github/scripts/sync/deliver.ts";
import {
  buildReport,
  holdReasons,
  renderReport,
  type SyncOutcome,
} from "../../.github/scripts/sync/writer/report.ts";
import { FAILURE_ISSUE_TITLE } from "../../actions/shared/platform.ts";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/deliver.ts");
const TARGET = "Vivswan/hidden-server";
const PAT = "ghp_SENTINEL";
const BUILD = "abcdef0123456789abcdef0123456789abcdef01";
const REPORT = "## Sync report\n\n| Build |\n| --- |\n| x |\n";
const PR_URL = `https://github.com/${TARGET}/pull/7`;

// Like the real gh, the stub refuses `--slurp` beside `--jq` before any request.
const GIT_LINES = [
  'printf "git %s\\n" "$*" >>"$STUB_SEQUENCE"',
  'case "$*" in',
  '  *" add --all") if [ "${STUB_ADD_FAIL:-}" = 1 ]; then echo "fatal: unable to stage" >&2; exit 128; fi ;;',
  '  *" status --porcelain") if [ -n "${STUB_DIRTY:-}" ]; then echo " M x"; fi ;;',
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
  writer?: "success" | "failure" | "skipped";
  checkout?: "success" | "failure";
  /** The clone log checkout_target.ts left behind, when any. */
  checkoutLog?: string;
  stub?: Record<string, string>;
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
}

function run(options: Options = {}): Run {
  const root = temp.dir("deliver-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  mkdirSync(join(root, "target"));
  writeFileSync(join(runnerTemp, "summary.json"), JSON.stringify({ hold: options.hold ?? false }));
  writeFileSync(join(runnerTemp, "sync.log"), REPORT);
  if (options.checkoutLog !== undefined)
    writeFileSync(join(runnerTemp, "checkout.log"), options.checkoutLog);
  const sequenceFile = join(root, "sequence.log");
  writeFileSync(sequenceFile, "");
  const git = argvStub(root, "git", GIT_LINES);
  const gh = argvStub(root, "gh", GH_LINES);
  const result = boundedSpawnSync(["bun", SCRIPT], {
    cwd: root,
    env: {
      PATH: `${git.bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      TARGET,
      TARGET_PRIVATE: "true",
      TARGET_DIR: join(root, "target"),
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
  test("a tree the build already matches is unchanged: no push, no issue, and with no open PR nothing beyond the lookup", () => {
    const result = run();
    silent(result);
    expect(result.exitCode).toBe(0);
    expect(result.verdict).toBe("unchanged");
    expect(calls(result.git, "push")).toEqual([]);
    expect(calls(result.gh, "pr").map((argv) => argv[2])).toEqual(["list"]);
    expect(result.gh.some((argv) => argv[4] === "POST")).toBe(false);
  });

  test("an unchanged tree closes the open armed PR as obsolete: disarmed, closed with the reason, branch deleted", () => {
    const result = run({ stub: { STUB_PR: "12", STUB_ARMED: "true" } });
    silent(result);
    expect(result.verdict).toBe("unchanged");
    const disarmAt = result.sequence.findIndex((line) => line.includes("--disable-auto"));
    const closeAt = result.sequence.findIndex((line) => line.startsWith("gh pr close"));
    expect(disarmAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(disarmAt);
    const close = calls(result.gh, "pr", "close")[0];
    expect(close.slice(3)).toEqual([
      "12",
      "-R",
      TARGET,
      "--delete-branch",
      "--comment",
      `superseded: the target already matches build ${BUILD}`,
    ]);
    expect(calls(result.git, "push")).toEqual([]);
    expect(calls(result.gh, "pr", "edit")).toEqual([]);
    expect(result.gh.some((argv) => argv.includes("--auto"))).toBe(false);
    expect(result.log).toContain("closed the obsolete sync pull request #12");
  });

  test("a fork's PR from a same-named branch is skipped: the target's own PR is the one closed", () => {
    const list = JSON.stringify([
      { number: 9, isCrossRepository: true },
      { number: 12, isCrossRepository: false },
    ]);
    const result = run({ stub: { STUB_PR_LIST: list, STUB_ARMED: "true" } });
    silent(result);
    expect(result.verdict).toBe("unchanged");
    expect(calls(result.gh, "pr", "list")[0]).toContain("number,isCrossRepository");
    expect(calls(result.gh, "pr", "view")[0][3]).toBe("12");
    expect(calls(result.gh, "pr", "close")[0][3]).toBe("12");
    expect(result.sequence.some((line) => line.includes(" 9 "))).toBe(false);
  });

  test("a fork's PR alone is no sync PR: a change opens the target's own", () => {
    const list = JSON.stringify([{ number: 9, isCrossRepository: true }]);
    const result = run({ stub: { STUB_DIRTY: "1", STUB_PR_LIST: list } });
    silent(result);
    expect(result.verdict).toBe("opened");
    expect(calls(result.gh, "pr", "edit")).toEqual([]);
    expect(calls(result.gh, "pr", "view")).toEqual([]);
  });

  test("a listing gh returns unparsed files the failure instead of crashing", () => {
    const result = run({ stub: { STUB_PR_LIST: "not json" } });
    silent(result);
    expect(result.verdict).toBe("failed");
    expect(result.issueBody).toContain("listing the sync pull request failed");
  });

  test("an unchanged tree closes an open PR that was never armed without a disarm call", () => {
    const result = run({ stub: { STUB_PR: "12" } });
    expect(result.verdict).toBe("unchanged");
    expect(result.gh.some((argv) => argv.includes("--disable-auto"))).toBe(false);
    expect(calls(result.gh, "pr", "close")[0]).toContain("12");
  });

  test.each([
    ["pr list", "listing the sync pull request failed"],
    ["pr view", "reading the sync pull request's auto-merge state failed"],
    ["pr merge", "disarming the sync pull request's auto-merge failed"],
    ["pr close", "closing the obsolete sync pull request failed"],
  ])(
    "an unchanged tree whose obsolete-PR cleanup fails at `gh %s` files the failure and stops there",
    (command, reason) => {
      const result = run({ stub: { STUB_PR: "12", STUB_ARMED: "true", STUB_GH_FAIL: command } });
      silent(result);
      expect(result.verdict).toBe("failed");
      expect(result.issueBody).toContain(reason);
      const prLines = result.sequence.filter((line) => line.startsWith("gh pr"));
      expect(prLines.at(-1)?.startsWith(`gh ${command}`)).toBe(true);
    },
  );

  test("a clean change on a non-manual run opens the PR and arms auto-merge", () => {
    const result = run({ stub: { STUB_DIRTY: "1" } });
    silent(result);
    expect(result.verdict).toBe("opened");
    expect(result.git.map((argv) => argv.slice(3, 5).join(" "))).toContain("commit -q");
    const push = calls(result.git, "push")[0];
    expect(push).toContain("--force-with-lease=automation/repo-platform:");
    expect(push).toContain(`https://x-access-token:${PAT}@github.com/${TARGET}.git`);
    const create = calls(result.gh, "pr", "create")[0];
    expect(create).toContain("--base");
    expect(create).toContain("main");
    expect(create).toContain("--body-file");
    const merge = calls(result.gh, "pr", "merge")[0];
    expect(merge.slice(3)).toEqual(["7", "-R", TARGET, "--squash", "--auto"]);
    expect(result.log).not.toContain(PAT);
  });

  test("the PR body opens with the source line and carries the writer's report", () => {
    const root = run({ stub: { STUB_DIRTY: "1" } });
    const bodyArg = calls(root.gh, "pr", "create")[0];
    const body = readFileSync(bodyArg[bodyArg.indexOf("--body-file") + 1], "utf-8");
    expect(body).toContain(`build \`${BUILD}\``);
    expect(body).toContain(REPORT.trimEnd());
  });

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

  test("a manual run never arms auto-merge, even on a clean report", () => {
    const result = run({ manual: true, stub: { STUB_DIRTY: "1" } });
    expect(result.verdict).toBe("opened");
    expect(result.gh.some((argv) => argv.includes("--auto"))).toBe(false);
    expect(result.log).toContain("manual run");
  });

  test("a failed writer files the issue with the log tail and records the failed verdict", () => {
    const result = run({ writer: "failure" });
    silent(result);
    expect(result.exitCode).toBe(0);
    expect(result.verdict).toBe("failed");
    const create = result.gh.find((argv) => argv[4] === "POST");
    expect(create?.slice(1, 5)).toEqual(["api", `repos/${TARGET}/issues`, "--method", "POST"]);
    expect(create).toContain(`title=${FAILURE_ISSUE_TITLE}`);
    expect(result.issueBody).toContain("the writer exited with an error");
    expect(result.issueBody).toContain(REPORT.trimEnd());
    expect(calls(result.git, "push")).toEqual([]);
  });

  test("a failed checkout files the issue with the clone's log and without touching the tree", () => {
    const result = run({
      checkout: "failure",
      writer: "skipped",
      checkoutLog: "$ git clone -> exit 128\nfatal: could not read from remote\n",
    });
    expect(result.verdict).toBe("failed");
    expect(result.issueBody).toContain("the target checkout failed");
    expect(result.issueBody).toContain("## Checkout log");
    expect(result.issueBody).toContain("fatal: could not read from remote");
    expect(result.git).toEqual([]);
  });

  test("a failed git add files the issue instead of committing a partial tree", () => {
    const result = run({ stub: { STUB_DIRTY: "1", STUB_ADD_FAIL: "1" } });
    silent(result);
    expect(result.verdict).toBe("failed");
    expect(result.issueBody).toContain("git add failed in the target");
    expect(calls(result.git, "commit")).toEqual([]);
    expect(calls(result.git, "push")).toEqual([]);
  });

  test.each([
    {
      read: "errors",
      head: "error",
      reason: "git symbolic-ref failed in the target",
      logged: "$ git symbolic-ref -> exit 128\nfatal: not a git repository: target",
    },
    {
      read: "finds HEAD detached",
      head: "detached",
      reason: "git symbolic-ref failed in the target",
      logged: "$ git symbolic-ref -> exit 128\nfatal: ref HEAD is not a symbolic ref",
    },
    {
      read: "answers a ref outside refs/heads/",
      head: "refs/remotes/origin/main",
      reason: "the target checkout is not on a branch",
      logged: "$ git symbolic-ref -> exit 0",
    },
    {
      read: "answers nothing on exit 0",
      head: "empty",
      reason: "the target checkout is not on a branch",
      logged: "$ git symbolic-ref -> exit 0",
    },
  ])(
    "a checkout whose branch read $read files that failure, with git's words, before any branch or commit",
    ({ head, reason, logged }) => {
      const result = run({ stub: { STUB_DIRTY: "1", STUB_HEAD: head } });
      silent(result);
      expect(result.verdict).toBe("failed");
      expect(result.issueBody).toContain(
        `The repo-platform sync for this repository failed: ${reason}.`,
      );
      expect(result.issueBody).toContain(`## Delivery log\n\n\`\`\`\`text\n`);
      expect(result.issueBody).toContain(`${logged}\nfiling the failure report: ${reason}`);
      expect(result.git.map((argv) => argv[3])).toEqual([
        "config",
        "config",
        "add",
        "status",
        "symbolic-ref",
      ]);
    },
  );

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

  test("the longest delivery (a refresh that arms and closes an open failure report) is the chain the row budget counts", () => {
    const result = run({
      stub: { STUB_DIRTY: "1", STUB_PR: "7", STUB_ARMED: "true", STUB_ISSUE: "12 open" },
    });
    expect(result.verdict).toBe("refreshed");
    expect(result.sequence).toHaveLength(DELIVERY_CALLS);
  });

  test("a clean delivery closes an open failure report", () => {
    const result = run({ stub: { STUB_DIRTY: "1", STUB_ISSUE: "41 open" } });
    expect(result.verdict).toBe("opened");
    const patch = result.gh.find((argv) => argv[2] === `repos/${TARGET}/issues/41`);
    expect(patch).toContain("state=closed");
  });

  test.each([
    ["a clean delivery", {}, "opened", "state=closed"],
    ["a failed delivery", { STUB_PUSH_FAIL: "1" }, "failed", "state=open"],
  ])(
    "%s addresses the open failure report, never the older closed one",
    (_, stub, verdict, state) => {
      const result = run({ stub: { STUB_DIRTY: "1", ...stub, STUB_ISSUE: "8 closed\n12 open\n" } });
      silent(result);
      expect(result.verdict).toBe(verdict);
      const patches = result.gh
        .filter((argv) => argv[1] === "api" && argv[4] === "PATCH")
        .map((argv) => [argv[2], argv.find((word) => word.startsWith("state="))]);
      expect(patches).toEqual([[`repos/${TARGET}/issues/12`, state]]);
    },
  );

  test("a failure the target cannot take (the issue write refused) leaves no verdict and exits red", () => {
    const result = run({ writer: "failure", stub: { STUB_ISSUE_FAIL: "1" } });
    silent(result);
    expect(result.exitCode).toBe(1);
    expect(result.verdict).toBeNull();
  });
});

describe("failureBody", () => {
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

  test("tail keeps the last bytes of a long log and says how much it dropped", () => {
    const dir = temp.dir("deliver-tail-");
    const file = join(dir, "log");
    writeFileSync(file, `${"x".repeat(50)}END`);
    expect(tail(file, 10)).toBe("... (43 earlier bytes not shown)\nxxxxxxxEND");
    expect(tail(join(dir, "missing"))).toBe("");
  });
});

describe("closedFences", () => {
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

  test("a report under the cap is untouched", () => {
    expect(boundedReport(`## Sync report\n${review}`)).toBe(`## Sync report\n${review}`);
  });

  test("a report over the cap is cut on a line boundary, its Review section kept whole", () => {
    const report = `${longDiff}${review}`;
    const bounded = boundedReport(report);
    expect(bounded.length).toBeLessThanOrEqual(BODY_CAP);
    expect(bounded.startsWith("## Sync report\n\n### Replaced local edits")).toBe(true);
    expect(bounded).not.toContain(longLine);
    // The cut fell inside the diff's fence, so the fence is closed before the
    // marker and the Review section render as Markdown.
    expect(bounded).toContain("```diff\n```\n\n> [!WARNING]");
    expect(omitted(bounded)).toEqual([`\n${longLine}\n\`\`\``.length]);
    expect(bounded.endsWith(review)).toBe(true);
    const body = prBody({ operator: "o/r", build: BUILD, runUrl: "u", report });
    expect(body.length).toBeLessThan(65_536);
  });

  test("an oversized Review section behind an oversized diff keeps its heading and leading reasons", () => {
    const reasons = Array.from(
      { length: 1_750 },
      (_, i) => `- mirror skills/${i}/LICENSE.md refused`,
    );
    const bigReview = `\n### Review\n\nHold for review: **yes**\n\n${reasons.join("\n")}\n`;
    expect(bigReview.length).toBeGreaterThan(BODY_CAP);
    const bounded = boundedReport(`${longDiff}${bigReview}`);
    expect(bounded.length).toBeLessThanOrEqual(BODY_CAP);
    expect(bounded.startsWith("## Sync report\n")).toBe(true);
    expect(bounded).toContain(
      "\n### Review\n\nHold for review: **yes**\n\n- mirror skills/0/LICENSE.md refused\n",
    );
    expect(bounded).toContain("- mirror skills/1000/LICENSE.md refused\n");
    expect(bounded).not.toContain(longLine);
    // The Review section took the whole room, so the diff section left no
    // trace rather than a dangling heading; the one marker is the Review's.
    expect(bounded).not.toContain("Replaced local edits");
    expect(bounded).toMatch(new RegExp(`${CUT.source}$`));
    expect(omitted(bounded)).toHaveLength(1);
  });

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

  test("the tables and notes take their room before the diffs when both cannot fit", () => {
    const header = "## Sync report\n";
    const written = "\n### Written\n\n| Path |\n| --- |\n| `a` |\n";
    const replaced = `\n### Replaced local edits\n\n\`\`\`diff\n${"+d\n".repeat(200)}\`\`\`\n`;
    const retired = `\n### Retired\n\n| Path |\n| --- |\n${"| `r` |\n".repeat(20)}`;
    const cap = header.length + written.length + retired.length + review.length + 200;
    const bounded = boundedReport(`${header}${written}${replaced}${retired}${review}`, cap);
    expect(bounded.length).toBeLessThanOrEqual(cap);
    expect(
      bounded.startsWith(`${header}${written}\n### Replaced local edits\n\n\`\`\`diff\n+d\n`),
    ).toBe(true);
    expect(bounded.endsWith(`${retired}${review}`)).toBe(true);
    // The kept lines, the closing fence, and the marker are all that stand
    // for the diff section, and the marker accounts for the rest of it.
    const section = bounded.slice(
      header.length + written.length,
      -(retired.length + review.length),
    );
    const kept = section.slice(0, section.indexOf(MARKER)).replace(/\n```$/, "");
    expect(replaced.startsWith(kept)).toBe(true);
    expect(omitted(bounded)).toEqual([replaced.length - kept.length]);
  });

  test("a cut section keeps its whole heading line or leaves no trace, at every cap", () => {
    const header = "## Sync report\n";
    const written = `\n### Written\n\n| Path |\n| --- |\n${"| `a` |\n".repeat(30)}`;
    const report = `${header}${written}${review}`;
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
    // The cut fell inside the diff, whose fence is four backticks: three
    // would leave the marker and the Review section rendering as code.
    expect(bounded).toContain("@@\n ```\n-old\n````\n\n> [!WARNING]");
    expect(bounded.endsWith(review)).toBe(true);
  });

  test("a Review section that alone exceeds the cap is cut too", () => {
    const reasons = Array.from(
      { length: 3000 },
      (_, i) => `- mirror skills/${i}/LICENSE.md refused`,
    );
    const report = `## Sync report\n\n### Review\n\nHold for review: **yes**\n\n${reasons.join("\n")}\n`;
    const bounded = boundedReport(report);
    expect(bounded.length).toBeLessThanOrEqual(BODY_CAP);
    expect(bounded.startsWith("## Sync report\n\n### Review\n\nHold for review: **yes**")).toBe(
      true,
    );
    expect(bounded).toMatch(new RegExp(`${CUT.source}$`));
  });
});
