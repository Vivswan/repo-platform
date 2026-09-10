// deliver.ts run as the workflow runs it, with gh and git stubbed on PATH:
// the three clean outcomes and the failure path each write their verdict,
// the PR is armed only for a clean report on a non-manual run, an armed PR
// is disarmed before the branch moves, an unchanged tree closes the PR it
// makes obsolete, the failure issue carries the log tails, and nothing
// ever reaches stdout or stderr.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_CAP,
  boundedReport,
  FAILURE_ISSUE_TITLE,
  failureBody,
  fenceFor,
  prBody,
  tail,
} from "../../.github/scripts/sync/deliver.ts";
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

// git answers the tree, branch, lease, and push questions from STUB_*
// knobs; gh answers the issue lookup, the PR lookup, the arm state, and
// the create.
const GIT_LINES = [
  'printf "git %s\\n" "$*" >>"$STUB_SEQUENCE"',
  'case "$*" in',
  '  *" add --all") if [ "${STUB_ADD_FAIL:-}" = 1 ]; then echo "fatal: unable to stage" >&2; exit 128; fi ;;',
  '  *" status --porcelain") if [ -n "${STUB_DIRTY:-}" ]; then echo " M x"; fi ;;',
  '  *" rev-parse --abbrev-ref HEAD") echo main ;;',
  '  *" ls-remote "*) if [ -n "${STUB_TIP:-}" ]; then printf "%s\\trefs/heads/automation/repo-platform\\n" "$STUB_TIP"; fi ;;',
  '  *" push "*) if [ "${STUB_PUSH_FAIL:-}" = 1 ]; then echo "fatal: unable to access \'https://x-access-token:${STUB_PAT}@github.com/o/r.git/\': 403" >&2; exit 1; fi ;;',
  "esac",
];
const GH_LINES = [
  'printf "gh %s\\n" "$*" >>"$STUB_SEQUENCE"',
  'case "$*" in',
  '  "${STUB_GH_FAIL:-<none>}"*) echo "gh: HTTP 502" >&2; exit 1 ;;',
  '  "api user "*) echo token-bot ;;',
  '  *"/issues --method GET"*) printf "%s" "${STUB_ISSUE:-}" ;;',
  '  *"/issues --method POST"*|*"/issues/"*" --method PATCH"*) if [ "${STUB_ISSUE_FAIL:-}" = 1 ]; then echo "gh: Forbidden (HTTP 403)" >&2; exit 1; fi ;;',
  '  "pr list "*) printf "%s" "${STUB_PR:-}" ;;',
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
  /** Every git and gh call in the order they happened, one line each. */
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

/** The recorded calls whose words after the program (and git's `-C <dir>`) open with `lead`. */
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

  test("an existing armed PR is disarmed before the push, refreshed, and left disarmed when the report holds", () => {
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
    expect(calls(result.gh, "pr", "edit")[0].slice(3, 6)).toEqual(["12", "-R", TARGET]);
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

  test("a clean delivery closes an open failure report", () => {
    const result = run({ stub: { STUB_DIRTY: "1", STUB_ISSUE: "41 open" } });
    expect(result.verdict).toBe("opened");
    const patch = result.gh.find((argv) => argv[2] === `repos/${TARGET}/issues/41`);
    expect(patch).toContain("state=closed");
  });

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

describe("boundedReport", () => {
  const review =
    "\n### Review\n\nHold for review: **yes**\n\n- local edits replaced in README.md\n";

  test("a report under the cap is untouched", () => {
    expect(boundedReport(`## Sync report\n${review}`)).toBe(`## Sync report\n${review}`);
  });

  test("a report over the cap is cut on a line boundary, its Review section kept whole", () => {
    const longLine = `+${"x".repeat(70_000)}`;
    const report = `## Sync report\n\n### Replaced local edits\n\n\`\`\`diff\n${longLine}\n\`\`\`${review}`;
    const bounded = boundedReport(report);
    expect(bounded.length).toBeLessThanOrEqual(BODY_CAP);
    expect(bounded.startsWith("## Sync report\n\n### Replaced local edits")).toBe(true);
    expect(bounded).not.toContain(longLine);
    // The cut fell inside the diff's fence, so the fence is closed before the
    // banner and the Review section render as Markdown.
    expect(bounded).toContain("```diff\n```\n\n> [!WARNING]");
    expect(bounded.endsWith(review)).toBe(true);
    const body = prBody({ operator: "o/r", build: BUILD, runUrl: "u", report });
    expect(body.length).toBeLessThan(65_536);
  });

  test("a Review section that alone exceeds the cap is cut too", () => {
    const reasons = Array.from(
      { length: 3000 },
      (_, i) => `- mirror skills/${i}/LICENSE.md refused`,
    );
    const report = `## Sync report\n\n### Review\n\nHold for review: **yes**\n\n${reasons.join("\n")}\n`;
    const bounded = boundedReport(report);
    expect(bounded.length).toBeLessThanOrEqual(BODY_CAP);
    expect(bounded.startsWith("## Sync report\n\n### Review")).toBe(true);
    expect(bounded.endsWith("cut here to fit GitHub's body limit.\n")).toBe(true);
  });
});
