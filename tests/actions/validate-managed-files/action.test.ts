// The report step never fails, so a blocking verdict is readable in the PR conversation before the caller fails the job.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_SLUG } from "../../../actions/shared/platform";
import {
  classify,
  type Integrity,
  readVerdict,
  writeVerdict,
} from "../../../actions/validate-managed-files/src/verdict";
import { loadAction, type Step } from "../../shared/action_step";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const ACTION = join(import.meta.dir, "../../../actions/validate-managed-files");
const RUN_URL = "https://example.invalid/run/1";
const HEADING = "### Managed files check\n\n";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SHORT = COMMIT.slice(0, 12);
const FAILS = "This FAILS the check.";

// The sticky-comment steps gate on `report`'s two values and are continue-on-error, so a value the script
// spells one way and the manifest another is a comment never posted or never deleted, green. Both literals
// are read from the manifest's `if` lines, never spelled here.
const action = loadAction("actions/validate-managed-files/action.yml");
function commentGates(): { post: string; remove: string } {
  const gateOf = (id: string): string => {
    const step = action.runs.steps.find((s) => s.id === id);
    const match = /steps\.report\.outputs\.report == '([a-z]+)'/.exec(String(step?.if));
    if (match === null)
      throw new Error(`step '${id}' does not gate on steps.report.outputs.report`);
    return match[1];
  };
  return { post: gateOf("post-comment"), remove: gateOf("delete-comment") };
}
const REPORT = commentGates();

const fakeValidator = `import { writeFileSync } from "node:fs";
if (!process.env.FAKE_SKIP_REPORT) {
  writeFileSync(process.env.FINDINGS_FILE, process.env.FAKE_FINDINGS ?? "");
}
if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);
process.exit(Number(process.env.FAKE_EXIT ?? "0"));
`;

const fakeCheck = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.CHECK_ARGV, JSON.stringify(process.argv.slice(2)));
if (process.env.CHECK_STDOUT) console.log(process.env.CHECK_STDOUT);
if (process.env.CHECK_STDERR) console.error(process.env.CHECK_STDERR);
if (process.env.CHECK_SIGNAL) process.kill(process.pid, process.env.CHECK_SIGNAL);
process.exit(Number(process.env.CHECK_EXIT ?? "0"));
`;

const read = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

interface Scenario {
  env?: Record<string, string>;
  verdict?: Integrity | "absent" | "garbage";
  clearOutcome?: string;
  /** A platform checkout of the scenario's own making (a git repository for freshness), returning the commit to
   *  judge at; default a plain tree judged at COMMIT. */
  platform?: (dir: string) => string;
  /** The platform's package.json; a malformed one fails the install. */
  packageJson?: string;
}

interface Outcome {
  runExit: number | null;
  verdict: Integrity | null;
  outputs: string;
  summary: string;
  comment: string;
  /** The argv the recorded commit's check.ts received; null when it never ran. */
  checkArgv: string[] | null;
  platformRemoved: boolean;
  checkout: string;
}

function writeFakePlatform(dir: string, packageJson: string): void {
  mkdirSync(join(dir, "actions/validate-managed-files"), { recursive: true });
  writeFileSync(join(dir, "package.json"), packageJson);
  writeFileSync(join(dir, "actions/validate-managed-files/check.ts"), fakeCheck);
}

function play(scenario: Scenario): Outcome {
  const root = temp.dir("validate-managed-action-");
  const actionPath = join(root, "action");
  mkdirSync(join(actionPath, "validator"), { recursive: true });
  for (const name of ["src/run.ts", "src/report.ts", "src/verdict.ts"]) {
    mkdirSync(join(actionPath, "src"), { recursive: true });
    writeFileSync(
      join(actionPath, name),
      readFileSync(join(ACTION, name), "utf8").replaceAll("../../shared/", `${ACTION}/../shared/`),
    );
  }
  writeFileSync(join(actionPath, "validator", "validate_managed_files.ts"), fakeValidator);
  const platform = join(root, "platform");
  writeFakePlatform(platform, scenario.packageJson ?? '{"name": "fake", "private": true}\n');
  const commit = scenario.platform?.(platform) ?? COMMIT;
  const scratch = join(root, "scratch");
  const verdictFile = join(root, "verdict.json");
  const outputs = join(root, "outputs.txt");
  const summary = join(root, "summary.md");
  const comment = join(root, "comment.md");
  const checkArgv = join(root, "check-argv.json");
  // Resolved as run.ts resolves its cwd (macOS's /var is /private/var), so the argv it passes compares whole.
  mkdirSync(join(root, "checkout"));
  const checkout = realpathSync(join(root, "checkout"));
  writeFileSync(outputs, "");
  writeFileSync(summary, "");
  let runExit: number | null = null;
  if (scenario.verdict === undefined) {
    const result = boundedSpawnSync([process.execPath, join(actionPath, "src/run.ts")], {
      cwd: checkout,
      env: {
        ...fixtureGitEnv(),
        ACTION_BUN: process.execPath,
        ACTION_PATH: actionPath,
        COMMIT: commit,
        COMMIT_PROBLEM: "",
        PLATFORM_DIR: platform,
        PLATFORM_OUTCOME: "success",
        REPOSITORY: "OwnerOrg/demo",
        REPOSITORY_PRIVATE: "false",
        SCRATCH_DIR: scratch,
        VERDICT_FILE: verdictFile,
        GITHUB_STEP_SUMMARY: summary,
        CHECK_ARGV: checkArgv,
        ...scenario.env,
      },
      timeoutMs: 60_000,
    });
    runExit = result.exitCode;
  } else if (scenario.verdict === "garbage") {
    writeFileSync(verdictFile, '{"kind": "clean", "extra": 1}\n');
  } else if (scenario.verdict !== "absent") {
    writeVerdict(verdictFile, scenario.verdict);
  }
  const report = boundedSpawnSync([process.execPath, join(actionPath, "src/report.ts")], {
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: outputs,
      COMMENT_FILE: comment,
      VERDICT: verdictFile,
      CLEAR_OUTCOME: scenario.clearOutcome ?? "success",
      RUN_URL,
    },
  });
  expect(report.exitCode).toBe(0);
  return {
    runExit,
    verdict: existsSync(verdictFile) ? (JSON.parse(read(verdictFile)) as Integrity) : null,
    outputs: read(outputs),
    summary: read(summary),
    comment: read(comment),
    checkArgv: existsSync(checkArgv) ? (JSON.parse(read(checkArgv)) as string[]) : null,
    platformRemoved: !existsSync(platform),
    checkout,
  };
}

const notJudged = (text: string) =>
  `${HEADING}Not judged: ${text}. See the [run log](${RUN_URL}). ${FAILS}\n`;
const PASSED = `${HEADING}Passed - this repository is what repo-platform writes at the commit it was synced with.\n`;
const BLOCKED = `integrity=failure\nreport=${REPORT.post}\n`;
const CLEAN = `integrity=success\nreport=${REPORT.remove}\n`;
/** The one interface between the action at stable and every recorded commit's check.ts. */
const CHECK_ARGV = (checkout: string) => [
  "--target",
  checkout,
  "--repository",
  "OwnerOrg/demo",
  "--private",
  "false",
  "--build",
  COMMIT,
];
const NO_TAG = "The stable tag was not fetched, so freshness is unknown.\n\n";

const DIFF = `.typography-allow: differs from what ${SHORT} writes\n--- .typography-allow\n+++ .typography-allow\n@@\n-x\n+`;
const REMEDY =
  "Each path named differs from what repo-platform writes at the commit this repository was synced with " +
  "(the + lines are the sync's). Restore it from git history, or run the sync: on a pull request, the " +
  "`repo-platform:sync` label syncs its branch and brings a registration change's files with it.";
const checkSection = (body: string, remedy = `\n\n${REMEDY}`) =>
  `#### repo-platform at ${SHORT}\n\n\`\`\`diff\n${body}\n\`\`\`${remedy}`;
const REFUSED = "1 manifest record is not a shape the writer records";
const HYGIENE = "#### Errors (1)\n\n- ci.yml: does not parse as YAML";

describe("the recorded commit's check and the hygiene checks reach the report as one verdict", () => {
  // check.ts speaks through its exit code and stdout, the hygiene validator through its exit code and findings
  // file; a pair that disagrees on either side is not judged, and one not-judged side outweighs the other's findings.
  test.each<{
    reason: string;
    env: Record<string, string>;
    runExit: number;
    verdict: Integrity;
    outputs: string;
    comment: string;
  }>([
    {
      reason: "clean on both sides passes and clears a stale comment",
      env: {},
      runExit: 0,
      verdict: { kind: "clean" },
      outputs: CLEAN,
      comment: PASSED,
    },
    {
      reason: "a byte that differs at the recorded commit is posted with its diff and the remedy",
      env: { CHECK_EXIT: "1", CHECK_STDOUT: DIFF },
      runExit: 1,
      verdict: { kind: "findings", findings: checkSection(DIFF) },
      outputs: BLOCKED,
      comment: `${HEADING}${checkSection(DIFF)}\n\n${FAILS}\n`,
    },
    {
      reason: "the writer's refusal is posted as it was printed, its message being the remedy",
      env: { CHECK_EXIT: "2", CHECK_STDOUT: REFUSED },
      runExit: 1,
      verdict: { kind: "findings", findings: checkSection(REFUSED, "") },
      outputs: BLOCKED,
      comment: `${HEADING}${checkSection(REFUSED, "")}\n\n${FAILS}\n`,
    },
    {
      reason: "a hygiene finding alone blocks",
      env: { FAKE_EXIT: "1", FAKE_FINDINGS: `${HYGIENE}\n` },
      runExit: 1,
      verdict: { kind: "findings", findings: HYGIENE },
      outputs: BLOCKED,
      comment: `${HEADING}${HYGIENE}\n\n${FAILS}\n`,
    },
    {
      reason: "findings on both sides are one report, the recorded commit's first",
      env: { CHECK_EXIT: "1", CHECK_STDOUT: DIFF, FAKE_EXIT: "1", FAKE_FINDINGS: `${HYGIENE}\n` },
      runExit: 1,
      verdict: { kind: "findings", findings: `${checkSection(DIFF)}\n\n${HYGIENE}` },
      outputs: BLOCKED,
      comment: `${HEADING}${checkSection(DIFF)}\n\n${HYGIENE}\n\n${FAILS}\n`,
    },
    {
      reason: "a check that exited 1 printing nothing is not judged, with its stderr as the detail",
      env: { CHECK_EXIT: "1", CHECK_STDERR: "error: Cannot find module 'yaml'" },
      runExit: 1,
      verdict: {
        kind: "not-judged",
        reason: `repo-platform's check at ${SHORT} ended without a verdict (error: Cannot find module 'yaml')`,
      },
      outputs: BLOCKED,
      comment: notJudged(
        `repo-platform's check at ${SHORT} ended without a verdict (error: Cannot find module 'yaml')`,
      ),
    },
    {
      reason: "a check killed by a signal is not judged",
      env: { CHECK_SIGNAL: "SIGKILL" },
      runExit: 1,
      verdict: {
        kind: "not-judged",
        reason: `repo-platform's check at ${SHORT} ended without a verdict (died on SIGKILL)`,
      },
      outputs: BLOCKED,
      comment: notJudged(
        `repo-platform's check at ${SHORT} ended without a verdict (died on SIGKILL)`,
      ),
    },
    {
      reason: "a hygiene validator that exited 1 without a finding outweighs the check's findings",
      env: { CHECK_EXIT: "1", CHECK_STDOUT: DIFF, FAKE_EXIT: "1" },
      runExit: 1,
      verdict: { kind: "not-judged", reason: "the validator exited 1 without reporting a finding" },
      outputs: BLOCKED,
      comment: notJudged("the validator exited 1 without reporting a finding"),
    },
    {
      reason: "a hygiene validator that exited 0 yet reported findings is not judged",
      env: { FAKE_FINDINGS: "- x\n" },
      runExit: 1,
      verdict: { kind: "not-judged", reason: "the validator exited 0 yet reported findings" },
      outputs: BLOCKED,
      comment: notJudged("the validator exited 0 yet reported findings"),
    },
    {
      reason: "a hygiene validator that crashed before reporting is not judged",
      env: { FAKE_EXIT: "2", FAKE_SKIP_REPORT: "1" },
      runExit: 1,
      verdict: { kind: "not-judged", reason: "the validator exited 2 before reporting" },
      outputs: BLOCKED,
      comment: notJudged("the validator exited 2 before reporting"),
    },
    {
      reason: "a hygiene validator killed by a signal is not judged",
      env: { FAKE_SIGNAL: "SIGKILL" },
      runExit: 1,
      verdict: { kind: "not-judged", reason: "the validator died on SIGKILL" },
      outputs: BLOCKED,
      comment: notJudged("the validator died on SIGKILL"),
    },
  ])("$reason", ({ env, runExit, verdict, outputs, comment }) => {
    const outcome = play({ env });
    expect(outcome).toEqual({
      runExit,
      verdict,
      outputs,
      summary: `${NO_TAG}${outcome.comment}`,
      comment,
      checkArgv: CHECK_ARGV(outcome.checkout),
      platformRemoved: true,
      checkout: outcome.checkout,
    });
  });

  // Before the check can run, the recorded commit has to be read and checked out; each failure is the verdict, named.
  // With no commit the checkout was skipped, so whatever stands at the platform path is the repository's and stays.
  test.each<{
    reason: string;
    env: Record<string, string>;
    text: string;
    packageJson?: string;
    platformRemoved?: boolean;
  }>([
    {
      reason: "no commit could be read",
      env: {
        COMMIT: "",
        COMMIT_PROBLEM: "no synced commit recorded; merge the pending sync PR or dispatch a sync",
      },
      text: "no synced commit recorded; merge the pending sync PR or dispatch a sync",
      platformRemoved: false,
    },
    {
      reason: "the checkout at the commit failed",
      env: { PLATFORM_OUTCOME: "failure" },
      text: `repo-platform could not be checked out at ${SHORT} (checkout step outcome: failure); the recorded commit must be one it holds`,
    },
    {
      reason: "the checkout was skipped",
      env: { PLATFORM_OUTCOME: "skipped" },
      text: `repo-platform could not be checked out at ${SHORT} (checkout step outcome: skipped); the recorded commit must be one it holds`,
    },
    {
      reason: "the private input is not a boolean",
      env: { REPOSITORY_PRIVATE: "maybe" },
      text: 'the private input must be true or false, not "maybe"',
    },
    {
      reason: "the commit's dependencies would not install",
      env: {},
      packageJson: "{",
      text: `installing repo-platform's dependencies at ${SHORT} failed`,
    },
  ])(
    "$reason: not judged before the check runs",
    ({ env, text, packageJson, platformRemoved = true }) => {
      const outcome = play({ env, packageJson });
      expect(outcome).toEqual({
        runExit: 1,
        verdict: { kind: "not-judged", reason: text },
        outputs: BLOCKED,
        summary: notJudged(text),
        comment: notJudged(text),
        checkArgv: null,
        platformRemoved,
        checkout: outcome.checkout,
      });
    },
  );

  // A stale or planted verdict must never read as clean: the report trusts only a verdict the aligned validate
  // step wrote after a successful clear.
  test.each<{ reason: string; scenario: Scenario; text: string }>([
    {
      reason: "no verdict file (the validate step never ran)",
      scenario: { verdict: "absent" },
      text: "the aligned validator step wrote no verdict",
    },
    {
      reason: "a verdict file with a stray field",
      scenario: { verdict: "garbage" },
      text: "the aligned validator step wrote no verdict",
    },
    {
      reason: "a scratch root that could not be cleared",
      scenario: { verdict: { kind: "clean" }, clearOutcome: "failure" },
      text: "the scratch root could not be cleared (clear step outcome: failure)",
    },
  ])("the report alone fails closed on $reason", ({ scenario, text }) => {
    const outcome = play(scenario);
    expect([outcome.outputs, outcome.summary]).toEqual([BLOCKED, notJudged(text)]);
  });
});

describe("freshness against the stable tag informs and never fails", () => {
  // The platform checkout is a real repository here: the recorded commit is one of its commits and `stable` a tag,
  // so the line comes from git ancestry. Findings and a clean tree yield the same line and their own exit.
  const commitAll = (dir: string, message: string): string => {
    fixtureGit(dir, ["add", "-A"]);
    fixtureGit(dir, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", message]);
    return fixtureGit(dir, ["rev-parse", "HEAD"]);
  };
  const advance = (dir: string, name: string): string => {
    writeFileSync(join(dir, name), `${name}\n`);
    return commitAll(dir, name);
  };
  test.each<{
    reason: string;
    history: (dir: string) => { commit: string; line: string };
    env: Record<string, string>;
    kind: Integrity["kind"];
  }>([
    {
      reason: "stable names the recorded commit",
      history: (dir) => {
        fixtureGit(dir, ["init", "-q", "-b", "main"]);
        const commit = commitAll(dir, "recorded");
        fixtureGit(dir, ["tag", "stable"]);
        return { commit, line: `Up to date with stable (${commit.slice(0, 12)}).` };
      },
      env: {},
      kind: "clean",
    },
    {
      reason: "stable moved past the recorded commit, with findings",
      history: (dir) => {
        fixtureGit(dir, ["init", "-q", "-b", "main"]);
        const commit = commitAll(dir, "recorded");
        advance(dir, "one");
        const tip = advance(dir, "two");
        fixtureGit(dir, ["tag", "stable"]);
        return {
          commit,
          line:
            `stable moved 2 commits past the synced commit (${commit.slice(0, 12)} -> ${tip.slice(0, 12)}). ` +
            "A sync moves this repository's judge once it writes a change or the checker differs. Nothing here fails for that.",
        };
      },
      env: { CHECK_EXIT: "1", CHECK_STDOUT: DIFF },
      kind: "findings",
    },
    {
      reason: "the recorded commit is not on stable's history",
      history: (dir) => {
        fixtureGit(dir, ["init", "-q", "-b", "main"]);
        commitAll(dir, "base");
        fixtureGit(dir, ["tag", "stable"]);
        fixtureGit(dir, ["checkout", "-q", "-b", "side"]);
        const commit = advance(dir, "side");
        return {
          commit,
          line: `The synced commit (${commit.slice(0, 12)}) is not on stable's history. A sync re-stamps it once it writes a change or the checker differs.`,
        };
      },
      env: {},
      kind: "clean",
    },
    {
      // git merge-base exits 128 on a commit the checkout lacks: an errored look, never read as "not an ancestor".
      reason: "git cannot answer the ancestry question",
      history: (dir) => {
        fixtureGit(dir, ["init", "-q", "-b", "main"]);
        commitAll(dir, "base");
        fixtureGit(dir, ["tag", "stable"]);
        return { commit: "0".repeat(40), line: "Freshness is unknown: git could not answer (" };
      },
      env: {},
      kind: "clean",
    },
  ])("$reason", ({ history, env, kind }) => {
    let line = "";
    const outcome = play({
      env,
      platform: (dir) => {
        const made = history(dir);
        line = made.line;
        return made.commit;
      },
    });
    expect([outcome.verdict?.kind, outcome.runExit, outcome.platformRemoved]).toEqual([
      kind,
      kind === "clean" ? 0 : 1,
      true,
    ]);
    expect(outcome.summary.startsWith(line)).toBe(true);
  });
});

describe("action.yml", () => {
  // GitHub resolves these at run time and refuses none of them: a reference to a LATER step's output reads as empty,
  // so a checkout placed before the read would be skipped on every run; a `path` the two scripts spell differently is a
  // checkout read_commit.ts never guards and run.ts never finds; a shallow fetch answers freshness's ancestry question
  // wrong; an install placed after the checkout leaves the checkout in the workspace when it fails. None is a YAML error.
  test("the recorded commit is read before repo-platform is checked out at it, whole, into the path both scripts read", () => {
    const steps = action.runs.steps;
    const index = (id: string) => steps.findIndex((step) => step.id === id);
    const env = (id: string) => (steps[index(id)] as Step & { env: Record<string, string> }).env;
    const platform = steps[index("platform")] as Step & { with: Record<string, unknown> };
    expect(index("install")).toBeLessThan(index("platform"));
    expect(index("read-commit")).toBeLessThan(index("platform"));
    expect(index("platform")).toBeLessThan(index("validate"));
    expect([platform.with.repository, platform.with.ref, platform.with["fetch-depth"]]).toEqual([
      PLATFORM_SLUG,
      "${{ steps.read-commit.outputs.commit }}",
      0,
    ]);
    const dir = `\${{ github.workspace }}/${platform.with.path}`;
    expect([env("read-commit").PLATFORM_DIR, env("validate").PLATFORM_DIR]).toEqual([dir, dir]);
  });
});

describe("verdict.ts", () => {
  test("a timed-out validator is not judged, with the deadline in the reason", () => {
    const dir = temp.dir("verdict-classify-");
    const findingsFile = join(dir, "f.md");
    writeFileSync(findingsFile, "");
    expect(classify({ kind: "timed-out" }, 300_000, findingsFile)).toEqual({
      kind: "not-judged",
      reason: "the validator ran past its 300s deadline",
    });
  });

  // JSON.parse would accept a reordered or hand-edited verdict; only writeVerdict's own bytes are one.
  test("readVerdict accepts only writeVerdict's own bytes", () => {
    const dir = temp.dir("verdict-read-");
    const path = join(dir, "verdict.json");
    const verdict: Integrity = { kind: "findings", findings: "- x" };
    writeVerdict(path, verdict);
    expect(readVerdict(path)).toEqual(verdict);
    writeFileSync(path, '{"findings": "- x", "kind": "findings"}\n');
    expect(readVerdict(path).kind).toBe("not-judged");
    writeFileSync(path, '{"kind": "findings", "findings": ""}\n');
    expect(readVerdict(path).kind).toBe("not-judged");
  });
});
