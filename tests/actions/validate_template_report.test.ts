// Behaviour tests for the validate-template-report action: the REAL
// scripts run here against a stubbed gh. Nothing touches the network. The
// rendered job's remaining shape (thin caller, fail-last re-raise) is
// pinned by tests/templates/fleet_ci_shape.test.ts and the smoke harness.
//
// The contract under test is the three-leg split: INTEGRITY blocks (one
// verdict per run from the validator of the template the repository was
// rendered from - fetched at the FULL build sha its `_commit` records,
// never resolved from a short one, run on that tree's own bun; every
// inconsistent, crashed, timed-out, or signal-killed run is `not-judged`
// and blocks), the LATEST pass only warns (rules the next sync brings,
// never said twice), and FRESHNESS only informs, read from the ONE
// build-branch compare the fetch step makes and publishes only once the
// whole admission (build-branch membership, then the vintage floor) has
// passed, so a refused run has no distance to contradict its refusal. The
// comment is posted BEFORE
// the job fails so a blocking verdict is readable in the conversation, one
// comment is kept per PR rather than one per push, a clean-and-fresh run
// leaves no new comment but does clear a stale one, and every reporting
// failure degrades to a warning instead of taking the job down.
//
// Every scenario is judged WHOLE: the full rendered summary, the recorded
// API calls, the outputs file, the verdict file. A test that ignored a
// column could not catch a regression in it.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  BUN_VERSION_FILE,
  TREE_DIR,
  VALIDATOR_DIR,
  VALIDATOR_SCRIPT,
  validatorOf,
} from "../../actions/validate-template-report/aligned_tree";
import { recordedBuildSha } from "../../actions/validate-template-report/build_sha";
import {
  type ChildExit,
  capture,
  childExit,
  failureDetail,
  run,
  succeeded,
} from "../../actions/validate-template-report/runtime";
import {
  classify,
  type Integrity,
  readVerdict,
  writeVerdict,
} from "../../actions/validate-template-report/verdict";
import { ACTIONS_BASH_SHELL } from "../../scripts/check_ssot";
import { actionStepArgv } from "../shared/action_shell";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const ACTION = join(import.meta.dir, "../../actions/validate-template-report");
const MARKER = "<!-- repo-platform:validate-template -->";
const SHA = "6bf545284a2f8e32d82fdc663d4b3333f8fb37bf";
const REMEDY = "merge this repository's pending template sync PR";
const RUN_URL = "https://example.invalid/run/1";
const OPERATOR = "Vivswan/repo-platform";

// Serves the gate's gh calls and records every call so a scenario can
// assert the exact sequence; GH_FAIL fails every call before recording. It
// stands in for `gh api --jq`, so each fixture is already the filter's output.
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
case "$*" in
  *--method\\ PATCH*) echo "PATCH $*" >> "$CALLS"; exit 0 ;;
  *--method\\ POST*) echo "POST $*" >> "$CALLS"; exit 0 ;;
  *tarball/*)
    echo "TARBALL $*" >> "$CALLS"
    if [ -n "\${GH_TARBALL_FAIL:-}" ]; then echo "gh: HTTP 404: Not Found" >&2; exit 1; fi
    cat "$GH_TARBALL"
    exit 0
    ;;
  *compare/*...build*)
    echo "COMPARE $*" >> "$CALLS"
    if [ -n "\${GH_COMPARE_FAIL:-}" ]; then exit 1; fi
    printf '%s %s\\n' "\${GH_COMPARE_STATUS:-ahead}" "\${GH_AHEAD:-3}"
    exit 0
    ;;
  *compare/*)
    echo "COMPARE $*" >> "$CALLS"
    if [ -n "\${GH_VINTAGE_FAIL:-}" ]; then echo "gh: HTTP 500" >&2; exit 1; fi
    printf '%s\\n' "\${GH_VINTAGE_STATUS:-ahead}"
    exit 0
    ;;
  *contents/*)
    echo "CONTENTS $*" >> "$CALLS"
    if [ -n "\${GH_BASE_MISSING:-}" ]; then echo "gh: HTTP 404: Not Found (https://api.github.com/...)" >&2; exit 1; fi
    if [ -n "\${GH_BASE_KILLED:-}" ]; then echo "gh: HTTP 404: Not Found" >&2; kill -KILL $$; fi
    if [ -n "\${GH_BASE_FAIL:-}" ]; then echo "gh: HTTP 500" >&2; exit 1; fi
    cat "$GH_BASE_ANSWERS"
    exit 0
    ;;
esac
echo "LIST" >> "$CALLS"
cat "$GH_COMMENTS_ID"
`;

// Stands in for a build tree's validate_generated_files.ts: writes the
// report pair (unless told to skip), then exits or dies as told,
// so the judge's classification is what the test sees.
const fakeValidator = `import { writeFileSync } from "node:fs";
if (!process.env.FAKE_SKIP_REPORT) {
  writeFileSync(process.env.FINDINGS_FILE, process.env.FAKE_FINDINGS ?? "");
  writeFileSync(process.env.ADVISORIES_FILE, process.env.FAKE_ADVISORIES ?? "");
}
console.log("validated " + process.argv[2] + " from " + process.cwd());
if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);
process.exit(Number(process.env.FAKE_EXIT ?? "0"));
`;

const read = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};
/** The verdict file as written, or null when the step wrote none. */
const verdictIn = (path: string): Integrity | null =>
  existsSync(path) ? (JSON.parse(read(path)) as Integrity) : null;

function scratch(): { root: string; bin: string } {
  const root = temp.dir("validate-template-report-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  // A poisoned `bun` sits first on PATH in every harness: a step block that
  // ran bun by name instead of its recorded absolute path would exit 97.
  writeFileSync(join(bin, "bun"), '#!/usr/bin/env bash\necho "bun by name: $*" >&2\nexit 97\n', {
    mode: 0o755,
  });
  return { root, bin };
}

/** A step's run block from action.yml as the runner would execute it: the
 *  action-path expression resolved, the runner-temp expression resolved to
 *  `runnerTemp` when given, any other expression refused (env is the only
 *  other channel, and each harness supplies it). */
function stepRun(id: string, runnerTemp?: string): string {
  const steps = parseYaml(readFileSync(join(ACTION, "action.yml"), "utf8")).runs.steps as Record<
    string,
    unknown
  >[];
  const step = steps.find((s) => s.id === id);
  if (step === undefined) throw new Error(`no step ${id}`);
  let run = String(step.run).replaceAll("${{ github.action_path }}", ACTION);
  if (runnerTemp !== undefined) run = run.replaceAll("${{ runner.temp }}", runnerTemp);
  if (run.includes("${{")) throw new Error(`step ${id} run block carries an expression: ${run}`);
  return run;
}

/** Every file under `dir` with its content, as one comparable string. */
function snapshot(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return `${path.slice(dir.length)}\n${read(path)}`;
    })
    .sort()
    .join("\n---\n");
}

function writeAnswers(root: string, answers: string | undefined): void {
  if (answers === undefined) return;
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, ".github/.copier-answers.yml"), answers);
}

/** A fake validator script directory (actions/validate-template) at `dir`. */
function layValidator(dir: string, opts: { lockfile?: string; bunVersion?: boolean }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, VALIDATOR_SCRIPT), fakeValidator);
  writeFileSync(join(dir, "package.json"), '{"name":"validate-template","private":true}\n');
  if (opts.bunVersion ?? true) writeFileSync(join(dir, BUN_VERSION_FILE), "1.3.0\n");
  if (opts.lockfile !== undefined) writeFileSync(join(dir, "bun.lock"), opts.lockfile);
}

// --- report.ts ---------------------------------------------------------------

interface ReportOptions {
  /** The integrity leg's verdict; "absent" = no file, "garbage" = not a verdict. */
  verdict?: Integrity | "absent" | "garbage";
  /** The fetch step's compare outputs (empty = the step never got there). */
  compare?: string;
  aheadBy?: string;
  /** The build tip validator's pair; null = that step never wrote its findings. */
  latestFindings?: string | null;
  latestAdvisories?: string;
  event?: string;
  /** The id the marker search resolves to, or "" for no existing comment. */
  existing?: string;
  /** true = the action's bun was never installed: the recorded path is empty. */
  noBun?: boolean;
  env?: Record<string, string>;
}

function runReport(opts: ReportOptions = {}) {
  const { root, bin } = scratch();
  const verdictPath = join(root, "verdict.json");
  const verdict = opts.verdict ?? { kind: "clean", advisories: "" };
  if (verdict === "garbage") writeFileSync(verdictPath, '{"kind":"clean"}\n');
  else if (verdict !== "absent") writeFileSync(verdictPath, `${JSON.stringify(verdict)}\n`);
  const latestFindingsPath = join(root, "latest-findings.md");
  if (opts.latestFindings !== null) writeFileSync(latestFindingsPath, opts.latestFindings ?? "");
  const latestAdvisoriesPath = join(root, "latest-advisories.md");
  writeFileSync(latestAdvisoriesPath, opts.latestAdvisories ?? "");
  const calls = join(root, "calls.txt");
  const summary = join(root, "summary.md");
  writeFileSync(summary, "");
  const listing = join(root, "comments.json");
  writeFileSync(listing, opts.existing === undefined ? "" : `${opts.existing}\n`);
  const outputs = join(root, "outputs.txt");
  writeFileSync(outputs, "");
  // The report step's own run block: the one place `integrity` is set, on
  // the bun path and on the no-bun fallback.
  const proc = boundedSpawnSync(actionStepArgv(stepRun("report"), root), {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ACTION_BUN: opts.noBun ? "" : process.execPath,
      ACTION_PATH: ACTION,
      GITHUB_REPOSITORY: "Vivswan/managed-repo",
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: outputs,
      GH_TOKEN: "x",
      VERDICT: verdictPath,
      CLEAR_OUTCOME: "success",
      LATEST_FINDINGS: latestFindingsPath,
      LATEST_ADVISORIES: latestAdvisoriesPath,
      COMPARE_STATUS: opts.compare ?? "identical",
      AHEAD_BY: opts.aheadBy ?? "",
      EVENT_NAME: opts.event ?? "pull_request",
      PR_NUMBER: "12",
      RUN_URL,
      CALLS: calls,
      GH_COMMENTS_ID: listing,
      ...opts.env,
    },
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout + proc.stderr,
    outputs: read(outputs),
    calls: read(calls),
    summary: read(summary),
  };
}

describe("the action's reporting script", () => {
  const HEAD = `${MARKER}\n### Template check\n\n`;
  const PASSED =
    "#### Integrity\n\nPassed - this repository matches the state it was stamped with.";
  const notJudged = (reason: string) =>
    `#### Integrity\n\nNot judged: ${reason}. See the [run log](${RUN_URL}). This FAILS the check.`;
  const findingsOf = (findings: string) =>
    `#### Integrity\n\n${findings}\nManaged content changed outside a sync. Restore the file from git history, or run a recovery sync. This FAILS the check.`;
  const FRESH = "#### Freshness\n\nUp to date with the build branch.";
  const behind = (distance: string) =>
    `#### Freshness\n\nThis repository is behind the build branch${distance}. The next sync PR updates the managed files; nothing to do here.`;
  const notChecked = (reason: string) => `#### Freshness\n\nNot checked this run: ${reason}.`;
  const LATEST = "#### After your next sync";
  const upcoming = (lines: string) =>
    `\n\n${LATEST}\n\n${lines}\n\nThese are warnings. The next sync brings these rules.`;
  const NO_VERDICT = "the aligned validator step wrote no verdict";

  /** The rendered body: integrity, then the optional advisories and latest
   *  blocks, then freshness. */
  const bodyOf = (integrity: string, freshness: string, extra = "") =>
    `${HEAD}${integrity}${extra}\n\n${freshness}`;
  const LIST = "LIST\n";
  const post = (body: string) =>
    `${LIST}POST api --method POST repos/Vivswan/managed-repo/issues/12/comments -f body=${body} --silent\n`;
  const patch = (id: string, body: string) =>
    `${LIST}PATCH api --method PATCH repos/Vivswan/managed-repo/issues/comments/${id} -f body=${body} --silent\n`;
  const drift = "#### Errors (1)\n\n- ci.yml drifted";
  const codeql = "#### Advisories (1)\n\n- consider a codeql job";

  interface Expected {
    /** The exported `integrity` output, asserted beside the body it came from. */
    integrity: "success" | "failure";
    body: string;
    calls: string;
    output?: string;
  }
  const scenarios: [string, ReportOptions, Expected][] = [
    [
      "clean and fresh: no new comment at all",
      {},
      { integrity: "success", body: bodyOf(PASSED, FRESH), calls: LIST },
    ],
    [
      "clean and fresh still clears a comment a previous run left behind",
      { existing: "555" },
      {
        integrity: "success",
        body: bodyOf(PASSED, FRESH),
        calls: patch("555", bodyOf(PASSED, FRESH)),
      },
    ],
    [
      "findings post the findings and say they block; behind names the distance",
      {
        verdict: { kind: "findings", findings: drift, advisories: "" },
        compare: "ahead",
        aheadBy: "3",
      },
      {
        integrity: "failure",
        body: bodyOf(findingsOf(drift), behind(" by 3 commit(s)")),
        calls: post(bodyOf(findingsOf(drift), behind(" by 3 commit(s)"))),
      },
    ],
    [
      "an existing comment is updated, never duplicated",
      { verdict: { kind: "findings", findings: drift, advisories: "" }, existing: "77" },
      {
        integrity: "failure",
        body: bodyOf(findingsOf(drift), FRESH),
        calls: patch("77", bodyOf(findingsOf(drift), FRESH)),
      },
    ],
    [
      "advisories are reported without ever claiming to block",
      { verdict: { kind: "clean", advisories: codeql } },
      {
        integrity: "success",
        body: bodyOf(PASSED, FRESH, `\n\n${codeql}`),
        calls: post(bodyOf(PASSED, FRESH, `\n\n${codeql}`)),
      },
    ],
    // A refused `_commit` never reached the compare, so freshness names
    // the same refusal instead of claiming anything.
    [
      "a not-judged verdict blocks, and a compare that never ran names the refusal",
      {
        verdict: {
          kind: "not-judged",
          reason: `_commit 'abc1234' is not a full build sha; ${REMEDY}`,
        },
        compare: "",
      },
      {
        integrity: "failure",
        body: bodyOf(
          notJudged(`_commit 'abc1234' is not a full build sha; ${REMEDY}`),
          notChecked(`_commit 'abc1234' is not a full build sha; ${REMEDY}`),
        ),
        calls: post(
          bodyOf(
            notJudged(`_commit 'abc1234' is not a full build sha; ${REMEDY}`),
            notChecked(`_commit 'abc1234' is not a full build sha; ${REMEDY}`),
          ),
        ),
      },
    ],
    [
      "a diverged compare is a refusal too; freshness never renders behind from it",
      {
        verdict: {
          kind: "not-judged",
          reason: `_commit ${SHA} is not a published commit of ${OPERATOR}'s build branch (compare: diverged)`,
        },
        compare: "diverged",
        aheadBy: "0",
      },
      {
        integrity: "failure",
        body: bodyOf(
          notJudged(
            `_commit ${SHA} is not a published commit of ${OPERATOR}'s build branch (compare: diverged)`,
          ),
          notChecked(
            `_commit ${SHA} is not a published commit of ${OPERATOR}'s build branch (compare: diverged)`,
          ),
        ),
        calls: post(
          bodyOf(
            notJudged(
              `_commit ${SHA} is not a published commit of ${OPERATOR}'s build branch (compare: diverged)`,
            ),
            notChecked(
              `_commit ${SHA} is not a published commit of ${OPERATOR}'s build branch (compare: diverged)`,
            ),
          ),
        ),
      },
    ],
    // The compare passed, the judge did not: freshness still has its answer.
    [
      "a not-judged verdict after a good compare still reports freshness",
      {
        verdict: { kind: "not-judged", reason: "the validator died on SIGKILL" },
        compare: "ahead",
        aheadBy: "3",
      },
      {
        integrity: "failure",
        body: bodyOf(notJudged("the validator died on SIGKILL"), behind(" by 3 commit(s)")),
        calls: post(bodyOf(notJudged("the validator died on SIGKILL"), behind(" by 3 commit(s)"))),
      },
    ],
    // No verdict is never a pass: a judge step that crashed before writing
    // (or a file that is not a verdict) blocks with a reason.
    [
      "an absent verdict file blocks as not judged",
      { verdict: "absent" },
      {
        integrity: "failure",
        body: bodyOf(notJudged(NO_VERDICT), FRESH),
        calls: post(bodyOf(notJudged(NO_VERDICT), FRESH)),
      },
    ],
    [
      "a verdict file that is not a verdict blocks the same way",
      { verdict: "garbage" },
      {
        integrity: "failure",
        body: bodyOf(notJudged(NO_VERDICT), FRESH),
        calls: post(bodyOf(notJudged(NO_VERDICT), FRESH)),
      },
    ],
    // With the clear step failed, fetch never ran: a clean verdict on disk is
    // stale (or planted) and must not be read, no compare exists either, and
    // a latest pair at its paths is as untrusted as the verdict.
    [
      "a failed clear ignores a planted clean verdict and planted latest findings, and blocks",
      {
        env: { CLEAR_OUTCOME: "failure" },
        compare: "",
        latestFindings: "#### Errors (1)\n\n- a stale finding from an earlier run\n",
      },
      {
        integrity: "failure",
        body: bodyOf(
          notJudged("the scratch root could not be cleared (clear step outcome: failure)"),
          notChecked("the scratch root could not be cleared (clear step outcome: failure)"),
        ),
        calls: post(
          bodyOf(
            notJudged("the scratch root could not be cleared (clear step outcome: failure)"),
            notChecked("the scratch root could not be cleared (clear step outcome: failure)"),
          ),
        ),
      },
    ],
    [
      "behind without a distance still says behind",
      { compare: "ahead", aheadBy: "" },
      {
        integrity: "success",
        body: bodyOf(PASSED, behind("")),
        calls: post(bodyOf(PASSED, behind(""))),
      },
    ],
    // The fetch step publishes no such value; the fallback still names
    // whatever an unrecognised compare said rather than guessing.
    [
      "an unrecognised compare beside a judged verdict is named, not guessed",
      { compare: "error" },
      {
        integrity: "success",
        body: bodyOf(PASSED, notChecked("the build branch compare reported `error`")),
        calls: LIST,
      },
    ],
    // The build tip's validator knows rules the repository's pending sync
    // has not delivered; they are warnings on a passing check, and a line
    // the aligned validator already reported is not repeated under them.
    [
      "the latest validator's findings warn under their own heading, deduplicated",
      {
        verdict: { kind: "findings", findings: drift, advisories: codeql },
        latestFindings:
          "#### Errors (2)\n\n- ci.yml drifted\n- .github/SECURITY.md is missing - the template always generates it\n",
        latestAdvisories:
          "#### Advisories (2)\n\n- consider a codeql job\n- pin actions/setup-node\n",
      },
      {
        integrity: "failure",
        body: bodyOf(
          findingsOf(drift),
          FRESH,
          `\n\n${codeql}${upcoming("- .github/SECURITY.md is missing - the template always generates it\n- pin actions/setup-node")}`,
        ),
        calls: post(
          bodyOf(
            findingsOf(drift),
            FRESH,
            `\n\n${codeql}${upcoming("- .github/SECURITY.md is missing - the template always generates it\n- pin actions/setup-node")}`,
          ),
        ),
      },
    ],
    [
      "latest-only findings on a clean tree warn, comment, and still pass",
      { latestFindings: "#### Errors (1)\n\n- .github/SECURITY.md is missing\n" },
      {
        integrity: "success",
        body: bodyOf(PASSED, FRESH, upcoming("- .github/SECURITY.md is missing")),
        calls: post(bodyOf(PASSED, FRESH, upcoming("- .github/SECURITY.md is missing"))),
      },
    ],
    [
      "a latest pass that only echoes the aligned findings adds no section",
      {
        verdict: { kind: "findings", findings: drift, advisories: "" },
        latestFindings: `${drift}\n`,
      },
      {
        integrity: "failure",
        body: bodyOf(findingsOf(drift), FRESH),
        calls: post(bodyOf(findingsOf(drift), FRESH)),
      },
    ],
    // Absent is not empty: a latest step that never wrote its findings is a
    // setup failure, said as a warning on a check it cannot fail.
    [
      "a latest pass that never reported says so without blocking",
      { latestFindings: null },
      {
        integrity: "success",
        body: bodyOf(
          PASSED,
          FRESH,
          `\n\n${LATEST}\n\nThe current template's validator exited before reporting. See the [run log](${RUN_URL}).`,
        ),
        calls: post(
          bodyOf(
            PASSED,
            FRESH,
            `\n\n${LATEST}\n\nThe current template's validator exited before reporting. See the [run log](${RUN_URL}).`,
          ),
        ),
      },
    ],
    [
      "a push writes the summary and never touches the comments API",
      { compare: "ahead", aheadBy: "3", event: "push" },
      { integrity: "success", body: bodyOf(PASSED, behind(" by 3 commit(s)")), calls: "" },
    ],
    [
      "a comments API failure degrades to a warning, never failing the step",
      { verdict: { kind: "findings", findings: drift, advisories: "" }, env: { GH_FAIL: "1" } },
      {
        integrity: "failure",
        body: bodyOf(findingsOf(drift), FRESH),
        calls: "",
        output:
          "::warning::could not list PR comments; the findings are in the job summary instead.\n",
      },
    ],
    // No bun at all (an empty recorded path): the step exports the failure
    // itself and writes one summary line, with no comment to post.
    [
      "no bun to render with still exports failure and says why",
      { noBun: true },
      {
        integrity: "failure",
        body: `### Template check\n\n#### Integrity\n\nNot judged: the action's pinned bun is unavailable. See the [run log](${RUN_URL}). This FAILS the check.`,
        calls: "",
        output: "::error::the action's pinned bun is unavailable\n",
      },
    ],
  ];
  test.each(scenarios)("%s", (_name, opts, expected) => {
    expect(runReport(opts)).toEqual({
      exitCode: 0,
      output: expected.output ?? "",
      outputs: `integrity=${expected.integrity}\n`,
      calls: expected.calls,
      summary: `${expected.body}\n`,
    });
  });

  // The fetch and report steps wired as action.yml wires them (an
  // unpublished step output reaches the report as empty). A floor refusal
  // after `ahead 3` must render one story: not judged, freshness not checked.
  test("a vintage-floor refusal renders one story: not judged, freshness not checked", () => {
    const BASE = "1111111111111111111111111111111111111111";
    const reason = `_commit moves backwards from main's ${BASE} to ${SHA} (compare: behind)`;
    const fetched = runFetch({
      answers: `_commit: ${SHA}\n`,
      base: `_commit: ${BASE}\n`,
      env: { GH_VINTAGE_STATUS: "behind" },
    });
    expect(fetched.verdict).toEqual({ kind: "not-judged", reason });
    const published = Object.fromEntries(
      fetched.outputs
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("=", 2) as [string, string]),
    );
    const reported = runReport({
      verdict: fetched.verdict as Integrity,
      compare: published.compare ?? "",
      aheadBy: published["ahead-by"] ?? "",
    });
    const body = bodyOf(notJudged(reason), notChecked(reason));
    expect(reported).toEqual({
      exitCode: 0,
      output: "",
      outputs: "integrity=failure\n",
      calls: post(body),
      summary: `${body}\n`,
    });
  });
});

// --- verdict.ts and runtime.run ------------------------------------------------

describe("the integrity verdict", () => {
  // A "/dev/null" entry points the report path at the device itself; a
  // "@link" entry makes it a symlink to an empty regular file elsewhere.
  const files = (root: string, findings?: string, advisories?: string) => {
    const pathOf = (name: string, content?: string): string => {
      if (content === "/dev/null") return content;
      const path = join(root, name);
      if (content === "@link") {
        writeFileSync(`${path}.target`, "");
        symlinkSync(`${path}.target`, path);
      } else if (content !== undefined) {
        writeFileSync(path, content);
      }
      return path;
    };
    return { findings: pathOf("f.md", findings), advisories: pathOf("a.md", advisories) };
  };
  const exited = (code: number): ChildExit => ({ kind: "exited", code });
  // Every way the child's exit and its report pair can disagree is
  // not-judged; only the two consistent pairs are verdicts.
  const cases: [string, ChildExit, [string?, string?], Integrity][] = [
    [
      "exit 0 with an empty findings file is clean",
      exited(0),
      ["", ""],
      { kind: "clean", advisories: "" },
    ],
    [
      "exit 0 carries the advisories along",
      exited(0),
      ["", "#### Advisories (1)\n\n- x\n"],
      { kind: "clean", advisories: "#### Advisories (1)\n\n- x" },
    ],
    [
      "exit 1 with findings is the findings verdict",
      exited(1),
      ["#### Errors (1)\n\n- drift\n", ""],
      { kind: "findings", findings: "#### Errors (1)\n\n- drift", advisories: "" },
    ],
    [
      "exit 1 with an EMPTY findings file is not a pass",
      exited(1),
      ["", ""],
      { kind: "not-judged", reason: "the validator exited 1 without reporting a finding" },
    ],
    [
      "exit 0 with findings is not a pass either",
      exited(0),
      ["#### Errors (1)\n\n- drift\n", ""],
      { kind: "not-judged", reason: "the validator exited 0 yet reported findings" },
    ],
    [
      "exit 0 with no report files is a crash before reporting",
      exited(0),
      [undefined, undefined],
      { kind: "not-judged", reason: "the validator exited 0 before reporting" },
    ],
    [
      "exit 2 with only the findings file written is still before reporting",
      exited(2),
      ["", undefined],
      { kind: "not-judged", reason: "the validator exited 2 before reporting" },
    ],
    // Not a regular file: a device or a planted link is no report at all.
    ...(["/dev/null", "@link"] as const).map(
      (shape): [string, ChildExit, [string?, string?], Integrity] => [
        `exit 0 with report paths that are ${shape} is before reporting`,
        exited(0),
        [shape, shape],
        { kind: "not-judged", reason: "the validator exited 0 before reporting" },
      ],
    ),
    [
      "a timeout names the deadline, whatever the files say",
      { kind: "timed-out" },
      ["", ""],
      { kind: "not-judged", reason: "the validator ran past its 300s deadline" },
    ],
    [
      "a signal death names the signal, whatever the files say",
      { kind: "signaled", signal: "SIGKILL" },
      ["", ""],
      { kind: "not-judged", reason: "the validator died on SIGKILL" },
    ],
  ];
  test.each(cases)("%s", (_name, exit, [findings, advisories], expected) => {
    const root = temp.dir("verdict-");
    expect(classify(exit, 300_000, files(root, findings, advisories))).toEqual(expected);
  });

  test("readVerdict rejects anything that is not a whole verdict", () => {
    const root = temp.dir("verdict-");
    const none = {
      kind: "not-judged",
      reason: "the aligned validator step wrote no verdict",
    };
    const path = join(root, "v.json");
    expect(readVerdict(path)).toEqual(none);
    for (const text of [
      "",
      "nope",
      "[]",
      '{"kind":"clean"}',
      '{"kind":"findings","findings":"x"}',
      '{"kind":"not-judged"}',
      '{"kind":"passed","advisories":""}',
      // Contradictions: a clean verdict carrying findings, a findings
      // verdict without any, a not-judged one without a reason.
      '{"kind":"clean","advisories":"","findings":"drift"}',
      '{"kind":"findings","findings":"","advisories":""}',
      '{"kind":"not-judged","reason":""}',
      '{"kind":"not-judged","reason":"x","advisories":""}',
      // Not writeVerdict's own bytes: JSON.parse resolves a duplicate key
      // to the last one, reorders nothing, and ignores a missing newline.
      '{"kind":"not-judged","kind":"clean","advisories":""}\n',
      '{"advisories":"","kind":"clean"}\n',
      '{"kind":"clean","advisories":""}',
    ]) {
      writeFileSync(path, text);
      expect(readVerdict(path)).toEqual(none);
    }
    writeFileSync(path, '{"kind":"findings","findings":"f","advisories":"a"}\n');
    expect(readVerdict(path)).toEqual({ kind: "findings", findings: "f", advisories: "a" });
    // A writer's construction order never leaks into the bytes.
    for (const verdict of [
      { advisories: "a", findings: "f", kind: "findings" },
      { advisories: "", kind: "clean" },
      { reason: "r", kind: "not-judged" },
    ] as Integrity[]) {
      writeVerdict(path, verdict);
      expect(readVerdict(path)).toEqual(verdict);
    }
  });

  // run() must keep the three ways a child ends apart: the classifier
  // above reads them, and a timeout folded into "exit 1" would render as
  // an exit the validator never made.
  test.each([
    ["a normal exit", ["sh", "-c", "exit 3"], 5_000, { kind: "exited", code: 3 }],
    ["a deadline", ["sleep", "5"], 200, { kind: "timed-out" }],
    [
      "a signal death",
      ["bun", "-e", "process.kill(process.pid, 'SIGKILL')"],
      5_000,
      { kind: "signaled", signal: "SIGKILL" },
    ],
  ])("run() reports %s as itself", (_name, command, timeoutMs, expected) => {
    expect(run(command, { timeoutMs })).toEqual(expected);
  });
});

// failureDetail's formatting, pinned on known input so the end-to-end fetch
// and judge cases below need not name a platform-specific tool.
describe("a failed child's one-line detail", () => {
  const failed = (stderr: string, exit: ChildExit = { kind: "exited", code: 2 }) => ({
    exit,
    stdout: "",
    stderr,
  });
  test.each([
    [
      "the first non-empty stderr line, trimmed",
      failed("\n  gzip: stdin: not in gzip format \ntar: Child returned status 1\n"),
      "gzip: stdin: not in gzip format",
    ],
    [
      "a single line as is",
      failed("tar: Error opening archive: Unrecognized archive format"),
      "tar: Error opening archive: Unrecognized archive format",
    ],
    ["the exit code when stderr is empty", failed(""), "exit 2"],
    ["the exit code when stderr is only whitespace", failed(" \n\t\n"), "exit 2"],
    ["the deadline over any stderr", failed("tar: something", { kind: "timed-out" }), "timed out"],
    [
      "the signal over any stderr",
      failed("tar: something", { kind: "signaled", signal: "SIGKILL" }),
      "died on SIGKILL",
    ],
  ])("%s", (_name, result, expected) => {
    expect(failureDetail(result)).toBe(expected);
  });
});

// How a child ended is classified once for capture(), download(), and
// run(): the deadline wins over everything else the runtime reports.
describe("how a child ended", () => {
  test.each([
    [
      "the deadline, even beside exit 0 (an orphan held the pipe open)",
      { exitedDueToTimeout: true, exitCode: 0, signalCode: null },
      { kind: "timed-out" },
    ],
    [
      "a normal exit",
      { exitedDueToTimeout: false, exitCode: 3, signalCode: null },
      { kind: "exited", code: 3 },
    ],
    [
      "a signal",
      { exitCode: null, signalCode: "SIGKILL" },
      { kind: "signaled", signal: "SIGKILL" },
    ],
    [
      "an exit code beside a signal is the exit",
      { exitedDueToTimeout: false, exitCode: 3, signalCode: "SIGKILL" },
      { kind: "exited", code: 3 },
    ],
    [
      "nothing reported at all",
      { exitCode: null, signalCode: undefined },
      { kind: "signaled", signal: "an unknown signal" },
    ],
  ])("%s", (_name, proc, expected) => {
    expect(childExit(proc)).toEqual(expected);
  });

  test("capture() reports a child whose orphan held the pipe past the deadline as timed out, not exit 0", () => {
    const result = capture(["sh", "-c", "sleep 3 & exit 0"], { timeoutMs: 300 });
    expect(result).toEqual({ exit: { kind: "timed-out" }, stdout: "", stderr: "" });
    expect(succeeded(result.exit)).toBe(false);
  });
});

// --- build_sha.ts ------------------------------------------------------------

describe("the recorded build sha", () => {
  // Read the way the stamp hook reads it (quoted or bare), then accepted
  // only as the full sha the sync writes: a short sha is refused with the
  // remedy, never resolved.
  const NO_COMMIT = `.github/.copier-answers.yml records no _commit; ${REMEDY}`;
  const cases: [string, string | undefined, ReturnType<typeof recordedBuildSha>][] = [
    ["a bare full sha", `_commit: ${SHA}\n`, { sha: SHA }],
    ["a double-quoted full sha", `_commit: "${SHA}"\n`, { sha: SHA }],
    ["a single-quoted full sha", `_commit: '${SHA}'\n`, { sha: SHA }],
    [
      "a full sha among other answers",
      `_src_path: gh:Vivswan/repo-platform\n_commit: ${SHA}\nproject_name: x\n`,
      { sha: SHA },
    ],
    [
      "copier's short sha is refused",
      "_commit: abc1234\n",
      { refusal: `_commit 'abc1234' is not a full build sha; ${REMEDY}` },
    ],
    [
      "an exponent-shaped short sha PyYAML left unquoted is refused as written",
      "_commit: 95e1875\n",
      { refusal: `_commit '95e1875' is not a full build sha; ${REMEDY}` },
    ],
    [
      "uppercase hex is not what git prints",
      `_commit: ${SHA.toUpperCase()}\n`,
      { refusal: `_commit '${SHA.toUpperCase()}' is not a full build sha; ${REMEDY}` },
    ],
    [
      "41 hex digits are not a sha",
      `_commit: ${SHA}a\n`,
      { refusal: `_commit '${SHA}a' is not a full build sha; ${REMEDY}` },
    ],
    ["no answers file", undefined, { refusal: NO_COMMIT }],
    [
      "answers without a _commit line",
      "_src_path: gh:Vivswan/repo-platform\n",
      { refusal: NO_COMMIT },
    ],
    ["an empty _commit", "_commit:\n", { refusal: NO_COMMIT }],
  ];
  test.each(cases)("%s", (_name, answers, expected) => {
    const root = temp.dir("build-sha-");
    writeAnswers(root, answers);
    expect(recordedBuildSha(root)).toEqual(expected);
  });
});

// --- fetch_aligned.ts --------------------------------------------------------

interface FetchOptions {
  /** undefined = no .github/.copier-answers.yml at all. */
  answers?: string;
  /** false = the served build tree ships no validator script directory. */
  validator?: boolean;
  /** false = the served validator ships no .bun-version. */
  bunVersion?: boolean;
  /** true = gh serves bytes that are not a tarball. */
  corrupt?: boolean;
  /** true = a tree and a verdict from an earlier run already sit in place. */
  stale?: boolean;
  /** true = ALIGNED_DIR is a symlink into another directory (a planted
   *  link must be replaced, never written through). */
  symlinked?: boolean;
  /** The base ref's answers file; null = none there (a 404, a first onboarding). */
  base?: string | null;
  env?: Record<string, string>;
}

/** A build-tree tarball the gh stub serves: GitHub's shape (one top-level
 *  directory) around the fake validator. */
function buildTarball(root: string, opts: FetchOptions): string {
  const TOP = "Vivswan-repo-platform-6bf5452";
  const top = join(root, "served", TOP);
  mkdirSync(join(top, "actions", "shared"), { recursive: true });
  writeFileSync(join(top, "copier.yml"), "_subdirectory: template\n");
  if (opts.validator ?? true) {
    layValidator(join(top, VALIDATOR_DIR), { bunVersion: opts.bunVersion });
  }
  const tarball = join(root, "tree.tgz");
  if (opts.corrupt) {
    writeFileSync(tarball, "not a tarball\n");
    return tarball;
  }
  const tar = boundedSpawnSync(["tar", "-czf", tarball, "-C", join(root, "served"), TOP]);
  expect(tar.exitCode).toBe(0);
  return tarball;
}

function runFetch(opts: FetchOptions = {}) {
  const { root, bin } = scratch();
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeAnswers(repo, opts.answers);
  const tarball = buildTarball(root, opts);
  const alignedDir = join(root, "aligned");
  const verdict = join(root, "verdict.json");
  if (opts.stale) {
    layValidator(validatorOf(alignedDir), {});
    writeFileSync(verdict, '{"kind":"clean","advisories":""}\n');
  }
  // A planted link's target: a validator tree with content of its own, so
  // a write through the link would change what snapshot() sees.
  const elsewhere = join(root, "elsewhere");
  let planted = "";
  if (opts.symlinked) {
    layValidator(validatorOf(elsewhere), {});
    writeFileSync(join(validatorOf(elsewhere), VALIDATOR_SCRIPT), "// planted, not fetched\n");
    planted = snapshot(elsewhere);
    symlinkSync(elsewhere, alignedDir);
  }
  const outputs = join(root, "outputs.txt");
  writeFileSync(outputs, "");
  const calls = join(root, "calls.txt");
  // The base ref's answers, served by the gh stub's contents endpoint: the
  // same sha by default, so the floor holds without a second compare.
  const baseAnswers = join(root, "base-answers.yml");
  writeFileSync(baseAnswers, opts.base ?? `_commit: ${SHA}\n`);
  const proc = boundedSpawnSync(actionStepArgv(stepRun("fetch"), root), {
    cwd: repo,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ACTION_BUN: process.execPath,
      GH_TOKEN: "x",
      GH_TARBALL: tarball,
      GH_BASE_ANSWERS: baseAnswers,
      ...(opts.base === null ? { GH_BASE_MISSING: "1" } : {}),
      GITHUB_REPOSITORY: "Vivswan/managed-repo",
      BASE_REF: "main",
      ALIGNED_DIR: alignedDir,
      VERDICT_FILE: verdict,
      GITHUB_OUTPUT: outputs,
      CALLS: calls,
      ...opts.env,
    },
  });
  return {
    exitCode: proc.exitCode,
    outputs: read(outputs),
    /** The gh calls made, in order: the build-branch compare, the base answers
     *  read, the floor compare when the shas differ, then the fetch. */
    calls: read(calls).trim(),
    /** null = no refusal was written (the judge step decides). */
    verdict: verdictIn(verdict),
    /** The tree the judge step would run: its script and bun pin in place. */
    tree: [VALIDATOR_SCRIPT, BUN_VERSION_FILE].every((name) =>
      existsSync(join(validatorOf(alignedDir), name)),
    ),
    /** The scratch root is gone or a real directory of ours (never a link),
     *  and a planted link's target was left alone. */
    ownDir: !existsSync(alignedDir) || !lstatSync(alignedDir).isSymbolicLink(),
    elsewhereIntact: !opts.symlinked || snapshot(elsewhere) === planted,
    errors: (proc.stdout + proc.stderr).match(/^::error::.*$/gm) ?? [],
  };
}

describe("the action's fetch script", () => {
  const BASE = "1111111111111111111111111111111111111111";
  const compared = `COMPARE api repos/${OPERATOR}/compare/${SHA}...build --jq "\\(.status) \\(.ahead_by)"`;
  const contents = `CONTENTS api --method GET -H Accept: application/vnd.github.raw+json repos/Vivswan/managed-repo/contents/.github/.copier-answers.yml -f ref=main`;
  const floor = `COMPARE api repos/${OPERATOR}/compare/${BASE}...${SHA} --jq .status`;
  const admitted = `${compared}\n${contents}`;
  const fetched = `${admitted}\nTARBALL api repos/${OPERATOR}/tarball/${SHA}`;
  const AHEAD = "compare=ahead\nahead-by=3\n";
  // A refusal publishes no compare, whatever the build-branch compare
  // said: freshness is the admission's outcome, not one leg of it. Only a
  // refusal PAST the admission (fetch, unpack, layout) leaves it published.
  const refused = (reason: string, calls = "", outputs = "") => ({
    exitCode: 1,
    outputs,
    calls,
    verdict: { kind: "not-judged", reason },
    tree: false,
    ownDir: true,
    elsewhereIntact: true,
    errors: [`::error::${reason}`],
  });
  const laidOut = (outputs: string, calls = fetched) => ({
    exitCode: 0,
    outputs,
    calls,
    verdict: null,
    tree: true,
    ownDir: true,
    elsewhereIntact: true,
    errors: [],
  });
  const runs: [string, FetchOptions, ReturnType<typeof runFetch>][] = [
    // Both statuses under which the build branch contains the sha.
    [
      "a full sha the build branch is ahead of lays the tree out and reports the distance",
      { answers: `_commit: ${SHA}\n` },
      laidOut(AHEAD),
    ],
    // The base ref rides as a query parameter, never spliced into the URL:
    // a `#` or `+` in a valid branch name would otherwise change the request.
    [
      "a base ref with URL-sensitive characters reaches gh as a parameter",
      { answers: `_commit: ${SHA}\n`, env: { BASE_REF: "feature/#12+x" } },
      laidOut(AHEAD, fetched.replace("-f ref=main", "-f ref=feature/#12+x")),
    ],
    // The vintage floor: `_commit` may move forward from the base ref's
    // along the build branch, never back to an older validator.
    [
      "a PR whose _commit is ahead of the base ref's is admitted after one more compare",
      { answers: `_commit: ${SHA}\n`, base: `_commit: ${BASE}\n` },
      laidOut(AHEAD, `${admitted}\n${floor}\nTARBALL api repos/${OPERATOR}/tarball/${SHA}`),
    ],
    [
      "a base ref with no answers file sets no floor",
      { answers: `_commit: ${SHA}\n`, base: null },
      laidOut(AHEAD),
    ],
    ...(["behind", "diverged"] as const).map(
      (relation): [string, FetchOptions, ReturnType<typeof runFetch>] => [
        `a PR moving _commit ${relation} the base ref's is refused unfetched`,
        {
          answers: `_commit: ${SHA}\n`,
          base: `_commit: ${BASE}\n`,
          env: { GH_VINTAGE_STATUS: relation },
        },
        refused(
          `_commit moves backwards from main's ${BASE} to ${SHA} (compare: ${relation})`,
          `${admitted}\n${floor}`,
        ),
      ],
    ),
    [
      "a floor compare that fails is refused, not waved through",
      { answers: `_commit: ${SHA}\n`, base: `_commit: ${BASE}\n`, env: { GH_VINTAGE_FAIL: "1" } },
      refused(
        `could not compare main's _commit ${BASE} with ${SHA}: gh: HTTP 500`,
        `${admitted}\n${floor}`,
      ),
    ],
    [
      "a base answers read that fails for any reason but 404 is refused",
      { answers: `_commit: ${SHA}\n`, env: { GH_BASE_FAIL: "1" } },
      refused(
        "could not read main's .github/.copier-answers.yml on Vivswan/managed-repo: gh: HTTP 500",
        admitted,
      ),
    ],
    [
      "a base read killed mid-flight is refused even with 404 in its stderr",
      { answers: `_commit: ${SHA}\n`, env: { GH_BASE_KILLED: "1" } },
      refused(
        "could not read main's .github/.copier-answers.yml on Vivswan/managed-repo: died on SIGKILL",
        admitted,
      ),
    ],
    [
      "a base ref recording a short sha is refused as the floor",
      { answers: `_commit: ${SHA}\n`, base: "_commit: abc1234\n" },
      refused(`on main, _commit 'abc1234' is not a full build sha; ${REMEDY}`, admitted),
    ],
    [
      "no base ref at all is refused before anything else",
      { answers: `_commit: ${SHA}\n`, env: { BASE_REF: "" } },
      refused("no base ref to read the vintage floor from (BASE_REF is empty)"),
    ],
    [
      "a quoted full sha at the build tip lays the tree out and reports identical",
      { answers: `_commit: "${SHA}"\n`, env: { GH_COMPARE_STATUS: "identical", GH_AHEAD: "0" } },
      laidOut("compare=identical\nahead-by=0\n"),
    ],
    [
      "a short sha is refused before gh is asked anything",
      { answers: "_commit: abc1234\n" },
      refused(`_commit 'abc1234' is not a full build sha; ${REMEDY}`),
    ],
    [
      "no answers file is refused the same way",
      {},
      refused(`.github/.copier-answers.yml records no _commit; ${REMEDY}`),
    ],
    [
      "a gh outage fails closed before anything is fetched, with gh's own words",
      { answers: `_commit: ${SHA}\n`, env: { GH_FAIL: "1" } },
      refused(`could not confirm ${SHA} is on ${OPERATOR}'s build branch: gh: boom`),
    ],
    [
      "a compare that fails without a message still names the step that failed",
      { answers: `_commit: ${SHA}\n`, env: { GH_COMPARE_FAIL: "1" } },
      refused(`could not confirm ${SHA} is on ${OPERATOR}'s build branch: exit 1`, compared),
    ],
    // The tarball endpoint would serve any commit in the repository's
    // network, and the answers file is PR-editable: only a commit the
    // protected build branch already contains may run.
    ...(["diverged", "behind"] as const).map(
      (status): [string, FetchOptions, ReturnType<typeof runFetch>] => [
        `a sha the build branch does not contain (compare: ${status}) is refused unfetched`,
        { answers: `_commit: ${SHA}\n`, env: { GH_COMPARE_STATUS: status, GH_AHEAD: "0" } },
        refused(
          `_commit ${SHA} is not a published commit of ${OPERATOR}'s build branch (compare: ${status})`,
          compared,
        ),
      ],
    ),
    [
      "a fetch that fails after the compare passed fails closed with gh's own words",
      { answers: `_commit: ${SHA}\n`, env: { GH_TARBALL_FAIL: "1" } },
      refused(`could not fetch ${OPERATOR} at ${SHA}: gh: HTTP 404: Not Found`, fetched, AHEAD),
    ],
    [
      "a build tree without the validator fails closed",
      { answers: `_commit: ${SHA}\n`, validator: false },
      refused(
        `${OPERATOR} at ${SHA} ships no ${VALIDATOR_DIR}/${VALIDATOR_SCRIPT}`,
        fetched,
        AHEAD,
      ),
    ],
    // The setup-bun step behind this one reads the tree's pin; a tree
    // without one would make that step fail hard instead of the gate.
    [
      "a validator without its bun pin fails closed",
      { answers: `_commit: ${SHA}\n`, bunVersion: false },
      refused(
        `${OPERATOR} at ${SHA} ships no ${VALIDATOR_DIR}/${BUN_VERSION_FILE}`,
        fetched,
        AHEAD,
      ),
    ],
    [
      "a tree and verdict left by an earlier run are cleared, never judged by",
      { answers: `_commit: ${SHA}\n`, validator: false, stale: true },
      refused(
        `${OPERATOR} at ${SHA} ships no ${VALIDATOR_DIR}/${VALIDATOR_SCRIPT}`,
        fetched,
        AHEAD,
      ),
    ],
    [
      "a scratch root planted as a symlink is replaced, never written through",
      { answers: `_commit: ${SHA}\n`, symlinked: true },
      laidOut(AHEAD),
    ],
    // The unpacker's complaint runs several lines and its wording differs
    // per platform (bsdtar, GNU tar behind gzip); the reason is the fixed
    // prefix plus ONE non-empty line of it, whatever the tool prints.
    [
      "bytes that are not a tarball fail closed with the unpacker's first line",
      { answers: `_commit: ${SHA}\n`, corrupt: true },
      {
        exitCode: 1,
        outputs: AHEAD,
        calls: fetched,
        verdict: {
          kind: "not-judged",
          reason: expect.stringMatching(
            new RegExp(`^could not unpack ${OPERATOR} at ${SHA}: \\S[^\\n]*$`),
          ),
        },
        tree: false,
        ownDir: true,
        elsewhereIntact: true,
        errors: [expect.stringMatching(/^::error::could not unpack /)],
      },
    ],
  ];
  test.each(runs)("%s", (_name, opts, expected) => {
    expect(runFetch(opts)).toEqual(expected);
  });
});

// --- judge_aligned.ts --------------------------------------------------------

interface JudgeOptions {
  /** A bun.lock to ship beside the fake validator (none by default). */
  lockfile?: string;
  /** The fetched tree's bun; the test runner's own by default. */
  alignedBun?: string;
  env?: Record<string, string>;
}

function runJudge(opts: JudgeOptions = {}) {
  const { root, bin } = scratch();
  const repo = join(root, "repo");
  mkdirSync(repo);
  const alignedDir = join(root, "aligned");
  layValidator(validatorOf(alignedDir), { lockfile: opts.lockfile });
  const verdict = join(root, "verdict.json");
  const proc = boundedSpawnSync(actionStepArgv(stepRun("integrity"), root), {
    cwd: repo,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ORCHESTRATOR_BUN: process.execPath,
      ALIGNED_DIR: alignedDir,
      VERDICT_FILE: verdict,
      ALIGNED_BUN: opts.alignedBun ?? process.execPath,
      ...opts.env,
    },
  });
  return {
    exitCode: proc.exitCode,
    verdict: verdictIn(verdict),
    // realpath: the script resolves its cwd, and tmpdir may be a symlink.
    judged: (proc.stdout + proc.stderr).includes(`validated ${realpathSync(repo)}`),
    errors: (proc.stdout + proc.stderr).match(/^::error::.*$/gm) ?? [],
  };
}

describe("the action's judge script", () => {
  // Judged whole: exit code (0 only for clean), the verdict written,
  // whether the validator judged the repository, and the error lines.
  const notJudged = (reason: string, judged = true) => ({
    exitCode: 1,
    verdict: { kind: "not-judged", reason },
    judged,
    errors: [`::error::${reason}`],
  });
  const runs: [string, JudgeOptions, ReturnType<typeof runJudge>][] = [
    [
      "a clean run is exit 0 with a clean verdict",
      {},
      { exitCode: 0, verdict: { kind: "clean", advisories: "" }, judged: true, errors: [] },
    ],
    [
      "findings ride the validator's exit 1 into the findings verdict",
      {
        env: {
          FAKE_FINDINGS: "#### Errors (1)\n\n- ci.yml drifted\n",
          FAKE_ADVISORIES: "#### Advisories (1)\n\n- consider a codeql job\n",
          FAKE_EXIT: "1",
        },
      },
      {
        exitCode: 1,
        verdict: {
          kind: "findings",
          findings: "#### Errors (1)\n\n- ci.yml drifted",
          advisories: "#### Advisories (1)\n\n- consider a codeql job",
        },
        judged: true,
        errors: [],
      },
    ],
    [
      "a nonzero exit with an empty findings file is not judged, never passed",
      { env: { FAKE_EXIT: "1" } },
      notJudged("the validator exited 1 without reporting a finding"),
    ],
    [
      "exit 0 beside findings is not judged either",
      { env: { FAKE_FINDINGS: "#### Errors (1)\n\n- drift\n" } },
      notJudged("the validator exited 0 yet reported findings"),
    ],
    [
      "exit 0 with no report files is a crash before reporting",
      { env: { FAKE_SKIP_REPORT: "1" } },
      notJudged("the validator exited 0 before reporting"),
    ],
    [
      "a validator killed by a signal is not judged",
      { env: { FAKE_SIGNAL: "SIGKILL" } },
      notJudged("the validator died on SIGKILL"),
    ],
    // An empty tree-bun path (none matching its pin on PATH) is not judged
    // at all: `bun` by name would be the action's.
    [
      "a tree with no bun matching its pin is not judged before anything runs",
      { alignedBun: "" },
      notJudged("no bun matching the fetched tree's .bun-version is available", false),
    ],
    // The fetched tree runs on the bun ALIGNED_BUN names, never on the one
    // running this script: a non-bun there fails the install, not the judge.
    [
      "a tree bun that is not bun is not judged before the validator runs",
      { alignedBun: "/usr/bin/false" },
      {
        exitCode: 1,
        verdict: {
          kind: "not-judged",
          reason: "could not install the validator's dependencies: exit 1",
        },
        judged: false,
        errors: ["::error::could not install the validator's dependencies: exit 1"],
      },
    ],
    [
      "a lockfile the frozen install rejects is not judged before the validator runs",
      { lockfile: "not a lockfile {\n" },
      {
        exitCode: 1,
        verdict: {
          kind: "not-judged",
          reason: expect.stringMatching(/^could not install the validator's dependencies: .+$/),
        },
        judged: false,
        errors: [expect.stringMatching(/^::error::could not install /)],
      },
    ],
  ];
  test.each(runs)("%s", (_name, opts, expected) => {
    expect(runJudge(opts)).toEqual(expected);
  });
});

// --- the latest leg ------------------------------------------------------------

interface LatestOptions {
  /** A bun.lock to ship beside the fake validator (none by default). */
  lockfile?: string;
  env?: Record<string, string>;
}

/** The latest step's run block as the runner would execute it, against a
 *  fake sibling validator: the poisoned `bun` on PATH would exit 97. */
function runLatest(opts: LatestOptions = {}) {
  const { root, bin } = scratch();
  const repo = join(root, "repo");
  mkdirSync(repo);
  const validator = join(root, "validate-template");
  layValidator(validator, { lockfile: opts.lockfile });
  const findings = join(root, "latest-findings.md");
  const advisories = join(root, "latest-advisories.md");
  const proc = boundedSpawnSync(actionStepArgv(stepRun("latest"), root), {
    cwd: repo,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ACTION_BUN: process.execPath,
      VALIDATOR_DIR: validator,
      FINDINGS_FILE: findings,
      ADVISORIES_FILE: advisories,
      ...opts.env,
    },
  });
  return {
    exitCode: proc.exitCode,
    // realpath: the fake prints its cwd, and tmpdir may be a symlink.
    judged: (proc.stdout + proc.stderr).includes(`validated . from ${realpathSync(repo)}`),
    findings: existsSync(findings) ? read(findings) : null,
    advisories: existsSync(advisories) ? read(advisories) : null,
  };
}

describe("the action's latest leg", () => {
  // Judged whole: the exit code (the step's colour only; continue-on-error
  // keeps the action going), whether the validator judged the caller's
  // checkout, and the report pair as report.ts will find it (null = never
  // written, which report.ts tells apart from empty).
  const runs: [string, LatestOptions, ReturnType<typeof runLatest>][] = [
    [
      "a clean run writes an empty pair",
      {},
      { exitCode: 0, judged: true, findings: "", advisories: "" },
    ],
    [
      "findings ride the validator's exit 1 into the pair",
      {
        env: {
          FAKE_FINDINGS: "#### Errors (1)\n\n- ci.yml drifted\n",
          FAKE_ADVISORIES: "#### Advisories (1)\n\n- consider a codeql job\n",
          FAKE_EXIT: "1",
        },
      },
      {
        exitCode: 1,
        judged: true,
        findings: "#### Errors (1)\n\n- ci.yml drifted\n",
        advisories: "#### Advisories (1)\n\n- consider a codeql job\n",
      },
    ],
    [
      "a lockfile the frozen install rejects stops the step before the validator runs",
      { lockfile: "not a lockfile {\n" },
      { exitCode: 1, judged: false, findings: null, advisories: null },
    ],
    [
      "a validator that exits before reporting leaves no pair",
      { env: { FAKE_SKIP_REPORT: "1" } },
      { exitCode: 0, judged: true, findings: null, advisories: null },
    ],
  ];
  test.each(runs)("%s", (_name, opts, expected) => {
    expect(runLatest(opts)).toEqual(expected);
  });
});

// --- action.yml --------------------------------------------------------------

// --- the clear step ------------------------------------------------------------

describe("the action's clear step", () => {
  // Executed as the runner would, with a planted scratch tree, a planted
  // clean verdict, and a planted latest-leg report pair where the action
  // expects them, under a poisoned rm first on PATH, a BASH_ENV that
  // redefines rm, and SHELLOPTS=noexec: the step's own env must defeat all
  // three. Judged whole: the exit code and which of the four paths remain.
  const runClear = (lockVerdict: boolean) => {
    const { root, bin } = scratch();
    const runnerTemp = join(root, "runner-temp");
    const alignedDir = join(runnerTemp, "aligned-validator");
    const verdict = join(runnerTemp, "aligned-verdict.json");
    const latestFindings = join(runnerTemp, "latest-findings.md");
    const latestAdvisories = join(runnerTemp, "latest-advisories.md");
    layValidator(validatorOf(alignedDir), {});
    writeFileSync(latestFindings, "#### Errors (1)\n\n- stale finding\n");
    writeFileSync(latestAdvisories, "#### Advisories (1)\n\n- stale advisory\n");
    if (lockVerdict) {
      // A directory rm cannot empty: its entry cannot be unlinked. Mode
      // bits bind no root, so the case cannot even be staged there.
      if (process.getuid?.() === 0)
        throw new Error("the locked-path case needs an unprivileged user");
      mkdirSync(verdict);
      writeFileSync(join(verdict, "planted"), "");
    } else {
      writeFileSync(verdict, '{"kind":"clean","advisories":""}\n');
    }
    writeFileSync(join(bin, "rm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const bashEnv = join(root, "bash_env.sh");
    writeFileSync(bashEnv, "rm() { :; }\n/bin/rm() { :; }\n");
    const steps = parseYaml(readFileSync(join(ACTION, "action.yml"), "utf8")).runs.steps as Record<
      string,
      unknown
    >[];
    const clear = steps.find((s) => s.id === "clear") as { env: Record<string, string> };
    let proc: ReturnType<typeof boundedSpawnSync>;
    if (lockVerdict) chmodSync(verdict, 0o555);
    try {
      proc = boundedSpawnSync(actionStepArgv(stepRun("clear", runnerTemp), root), {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          BASH_ENV: bashEnv,
          SHELLOPTS: "noexec",
          ...clear.env,
        },
      });
    } finally {
      if (lockVerdict) chmodSync(verdict, 0o755);
    }
    return {
      failed: proc.exitCode !== 0,
      remaining: [alignedDir, verdict, latestFindings, latestAdvisories]
        .filter((path) => existsSync(path))
        .map((path) => path.slice(runnerTemp.length + 1)),
    };
  };

  test("removes the planted scratch tree, verdict, and latest reports under a hostile environment", () => {
    expect(runClear(false)).toEqual({ failed: false, remaining: [] });
  });

  // One removal that cannot complete fails the whole step (so the report
  // trusts nothing on disk) while every other path is still cleared: a
  // fetch step gated on this outcome never runs beside a stale verdict.
  test("fails when one path cannot be removed, having still cleared the others", () => {
    expect(runClear(true)).toEqual({ failed: true, remaining: ["aligned-verdict.json"] });
  });
});

describe("the action's wiring", () => {
  // The plumbing the behaviour tests cannot see. Order is the contract, no
  // setup failure ends the action before the report, every bun-running
  // step reads the one resolved readiness output, and `integrity` has one
  // writer: the report step, which always runs.
  test("action.yml: every path ends in the report step, which alone sets integrity", () => {
    const action = parseYaml(readFileSync(join(ACTION, "action.yml"), "utf8"));
    const steps: Record<string, unknown>[] = action.runs.steps;
    const byId = (id: string) => steps.find((step) => step.id === id);
    const envOf = (step: Record<string, unknown> | undefined) =>
      (step?.env ?? {}) as Record<string, string>;
    expect(steps.map((step) => step.id)).toEqual([
      "bun",
      "setup-bun",
      "setup-bun-retry",
      "action-bun",
      "clear",
      "fetch",
      "aligned-bun",
      "aligned-bun-retry",
      "aligned-bun-path",
      "integrity",
      "latest",
      "report",
    ]);
    // One input, the token: the build tip's validator is this action's
    // sibling on the same branch, not a ref an input could move.
    expect(Object.keys(action.inputs)).toEqual(["github-token"]);
    // ONE writer of integrity: the report step's output, never a step outcome.
    expect(action.outputs.integrity.value).toBe("${{ steps.report.outputs.integrity }}");
    expect(JSON.stringify(action.outputs)).not.toMatch(/steps\.(integrity|latest|fetch)\./);

    // No setup-bun step, primary or retry, can end the action: a double
    // failure must reach the report step as a rendered not-judged reason.
    const setupBunSteps = steps.filter((step) =>
      String(step.uses ?? "")
        .toLowerCase()
        .startsWith("oven-sh/setup-bun@"),
    );
    expect(setupBunSteps.map((step) => step.id)).toEqual([
      "setup-bun",
      "setup-bun-retry",
      "aligned-bun",
      "aligned-bun-retry",
    ]);
    for (const step of setupBunSteps) expect(step["continue-on-error"]).toBe(true);
    expect(byId("setup-bun-retry")?.if).toBe("steps.setup-bun.outcome == 'failure'");
    const actionBun = byId("action-bun");
    // Readiness has one truth, a bun on PATH at the pinned version, resolved
    // by the one canonical block (the actions-bun-guard rule pins its text
    // and tests its behaviour) for the probe and both post-setup resolvers.
    // Every run step is privileged bash (the actions-bun-guard rule requires
    // it): a caller's BASH_ENV, SHELLOPTS or exported functions cannot run
    // before, rewrite, or redefine the lines the rule read.
    for (const step of steps) {
      if (typeof step.run === "string") expect(step.shell).toBe(ACTIONS_BASH_SHELL);
    }
    expect(envOf(actionBun)).toEqual({ PIN_FILE: "${{ github.action_path }}/.bun-version" });
    expect(String(byId("bun")?.run)).toBe(String(actionBun?.run));
    const alignedBunPath = byId("aligned-bun-path");
    expect(alignedBunPath?.if).toBe("steps.fetch.outcome == 'success'");
    expect(String(alignedBunPath?.run)).toBe(String(actionBun?.run));
    // The resolver runs whatever happened before it, so the always() report
    // step reads a recorded path, empty when no bun is pinned.
    expect(actionBun?.if).toBe("always()");
    const READY = "steps.action-bun.outputs.pinned == 'true'";
    expect(byId("fetch")?.if).toBe(`${READY} && steps.clear.outcome == 'success'`);
    expect(byId("latest")?.if).toBe(`${READY} && steps.clear.outcome == 'success'`);

    // Every action script runs by the recorded absolute path, never `bun`
    // by name: later setups put other buns on PATH.
    const BUN_PATH = "${{ steps.action-bun.outputs.path }}";
    const fetch = byId("fetch");
    expect(String(fetch?.run)).toBe('"$ACTION_BUN" "${{ github.action_path }}/fetch_aligned.ts"');
    // Every predictable scratch path is cleared by ONE fixed rm on the
    // literal paths (no variable or PATH entry a caller could poison; one rm
    // fails when any removal did): the aligned tree and verdict, which both
    // aligned setups require (the actions-bun-guard rule reads it), and the
    // latest leg's report pair, so an aborted latest validator leaves
    // nothing stale.
    const latest = byId("latest");
    expect(byId("clear")).toEqual({
      name: "Clear the scratch root",
      id: "clear",
      "continue-on-error": true,
      shell: ACTIONS_BASH_SHELL,
      run: `/bin/rm -rf ${[
        envOf(fetch).ALIGNED_DIR,
        envOf(fetch).VERDICT_FILE,
        envOf(latest).FINDINGS_FILE,
        envOf(latest).ADVISORIES_FILE,
      ]
        .map((path) => `"${path}"`)
        .join(" ")}`,
    });
    expect(envOf(fetch).ACTION_BUN).toBe(BUN_PATH);
    // The vintage floor reads the PR's base ref, or the default branch off a PR.
    expect(envOf(fetch).BASE_REF).toBe(
      "${{ github.base_ref || github.event.repository.default_branch }}",
    );
    expect(fetch?.["continue-on-error"]).toBe(true);
    const alignedDir = envOf(fetch).ALIGNED_DIR;
    const verdictFile = envOf(fetch).VERDICT_FILE;
    expect(alignedDir).toMatch(/^\$\{\{ runner\.temp \}\}\//);
    expect(verdictFile).toMatch(/^\$\{\{ runner\.temp \}\}\//);

    // The tree's bun: both setup steps read the pin where fetch_aligned.ts
    // lays it (the layout constants), only behind a successful fetch, and
    // the resolver behind them reads the same pin.
    const pin = `${alignedDir}/${TREE_DIR}/${VALIDATOR_DIR}/${BUN_VERSION_FILE}`;
    const setups = steps.filter(
      (step) =>
        String(step.uses ?? "").startsWith("oven-sh/setup-bun@") &&
        (step.with as Record<string, string>)["bun-version-file"] === pin,
    );
    expect(setups.map((step) => [step.id, step.if])).toEqual([
      ["aligned-bun", "steps.clear.outcome == 'success' && steps.fetch.outcome == 'success'"],
      [
        "aligned-bun-retry",
        "steps.clear.outcome == 'success' && steps.fetch.outcome == 'success' && steps.aligned-bun.outcome == 'failure'",
      ],
    ]);
    expect(envOf(byId("aligned-bun-path")).PIN_FILE).toBe(pin);

    const judge = byId("integrity");
    expect(String(judge?.run)).toContain("judge_aligned.ts");
    expect(judge?.if).toBe("steps.fetch.outcome == 'success'");
    expect(judge?.["continue-on-error"]).toBe(true);
    // The judge runs on the bun the fetch step recorded, and hands the
    // tree's bun (the one setup-bun put on PATH) to the install and run.
    expect(envOf(judge)).toEqual({
      ALIGNED_DIR: alignedDir,
      VERDICT_FILE: verdictFile,
      ORCHESTRATOR_BUN: BUN_PATH,
      ALIGNED_BUN: "${{ steps.aligned-bun-path.outputs.path }}",
    });
    expect(String(judge?.run)).toBe(
      '"$ORCHESTRATOR_BUN" "${{ github.action_path }}/judge_aligned.ts"',
    );

    // The latest leg runs the sibling validator (the build branch ships the
    // whole actions/ tree beside this action) on the recorded bun, with a
    // frozen install of the sibling's lockfile first; only behind a cleared
    // scratch root, since report.ts reads its pair on that condition.
    const sibling = `\${{ github.action_path }}/../${basename(VALIDATOR_DIR)}`;
    expect(latest).toEqual({
      name: "Run the build tip's validator",
      id: "latest",
      if: `${READY} && steps.clear.outcome == 'success'`,
      "continue-on-error": true,
      shell: ACTIONS_BASH_SHELL,
      env: {
        ACTION_BUN: BUN_PATH,
        VALIDATOR_DIR: sibling,
        FINDINGS_FILE: "${{ runner.temp }}/latest-findings.md",
        ADVISORIES_FILE: "${{ runner.temp }}/latest-advisories.md",
      },
      run: [
        '"$ACTION_BUN" install --frozen-lockfile --production --cwd "$VALIDATOR_DIR"',
        `"$ACTION_BUN" "$VALIDATOR_DIR/${VALIDATOR_SCRIPT}" .`,
        "",
      ].join("\n"),
    });
    // The sibling is a script directory, not an action: no manifest, and the
    // same generated pin as this action, so ACTION_BUN can read its lockfile.
    const siblingDir = join(ACTION, "..", basename(VALIDATOR_DIR));
    expect(
      ["action.yml", BUN_VERSION_FILE, "bun.lock", VALIDATOR_SCRIPT].map((name) =>
        existsSync(join(siblingDir, name)),
      ),
    ).toEqual([false, true, true, true]);
    expect(readFileSync(join(siblingDir, BUN_VERSION_FILE), "utf8")).toBe(
      readFileSync(join(ACTION, BUN_VERSION_FILE), "utf8"),
    );

    // The report runs whatever happened above, reads the verdict the
    // integrity leg wrote, the latest pair where that leg wrote it, and
    // the fetch step's compare outputs; its run block carries no
    // expression, so the behaviour tests execute it as the runner would.
    const report = byId("report");
    expect(report?.if).toBe("always()");
    expect(report?.["continue-on-error"]).toBeUndefined();
    expect(envOf(report)).toMatchObject({
      ACTION_BUN: BUN_PATH,
      ACTION_PATH: "${{ github.action_path }}",
      VERDICT: verdictFile,
      CLEAR_OUTCOME: "${{ steps.clear.outcome }}",
      LATEST_FINDINGS: envOf(latest).FINDINGS_FILE,
      LATEST_ADVISORIES: envOf(latest).ADVISORIES_FILE,
      COMPARE_STATUS: "${{ steps.fetch.outputs.compare }}",
      AHEAD_BY: "${{ steps.fetch.outputs.ahead-by }}",
    });
    expect(String(report?.run)).not.toContain("${{");
    expect(envOf(report).BUN_READY).toBeUndefined();
    expect(String(report?.run)).toContain(
      'if [ -n "$ACTION_BUN" ]; then\n  exec "$ACTION_BUN" "$ACTION_PATH/report.ts"',
    );
    expect(String(report?.run)).not.toMatch(/^\s*(exec\s+)?bun\s/m);

    // No leg renders: a copier run here would cost every fleet repo a
    // render per push, and freshness is the fetch step's compare.
    for (const name of ["fetch_aligned.ts", "judge_aligned.ts", "report.ts"]) {
      expect(readFileSync(join(ACTION, name), "utf8")).not.toMatch(/^\s*copier\s/m);
    }
  });

  test("nothing resolves validate-template as an action any more: this action runs the script", () => {
    // Templates, this repo's workflows, the golden renders, and the actions
    // themselves: a `uses:` of the retired manifest would 404 at job start.
    // One strict scan (a file that cannot be read throws, so a miss is never
    // an unread file) serves the assertion and its control; action
    // identifiers are case-insensitive, so the match is too; a `uses:` may
    // fold its value onto the next line (a block scalar, with indicators and
    // a trailing comment) or name the repo-local path (`./actions/...`, no
    // `@`, an optional trailing slash), so the pattern spans every spelling
    // actionlint accepts.
    const REPO_ROOT = join(import.meta.dir, "../..");
    const usesOf = (action: string) =>
      new RegExp(
        `(?:uses|"uses"|'uses')\\s*:\\s*(?:[>|][-+0-9]*(?:[ \\t]*#[^\\n]*)?\\s*)?["']?(?:\\./|[\\w./-]*/)actions/${action}/?(?:@|["']|\\s|$)`,
        "i",
      );
    for (const spelling of [
      "uses: Vivswan/repo-platform/actions/validate-template@build",
      'uses: "Vivswan/repo-platform/actions/validate-template@build"',
      "uses: >-\n        Vivswan/repo-platform/actions/validate-template@build",
      "uses: |\n        VIVSWAN/Repo-Platform/actions/validate-template@build",
      "uses: >- # the build tip\n        Vivswan/repo-platform/actions/validate-template@build",
      "uses: |+2\n        Vivswan/repo-platform/actions/validate-template@build",
      "uses : ./actions/validate-template",
      '"uses": ./actions/validate-template',
      "'uses': Vivswan/repo-platform/actions/validate-template@build",
      "uses: ./actions/validate-template/",
      'uses: "./actions/validate-template/"\n      with:',
    ]) {
      expect(usesOf("validate-template").test(spelling)).toBe(true);
    }
    for (const spelling of [
      "uses: x/actions/validate-template-report@build",
      "uses: ./actions/validate-template-report",
      "uses: ./actions/validate-template-report/",
      '"uses": ./actions/validate-template-report',
    ]) {
      expect(usesOf("validate-template").test(spelling)).toBe(false);
    }
    const filesCarrying = (pattern: RegExp): string[] =>
      ["templates", ".github/workflows", "tests/golden-renders", "actions"].flatMap((root) =>
        readdirSync(join(REPO_ROOT, root), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && !entry.parentPath.includes("/node_modules"))
          .map((entry) => join(entry.parentPath, entry.name))
          .filter((path) => pattern.test(readFileSync(path, "utf8")))
          .map((path) => path.slice(REPO_ROOT.length + 1)),
      );
    expect(filesCarrying(usesOf("validate-template"))).toEqual([]);
    // The control: the same scan sees the report action's own ref in the
    // fleet-ci workflow, so an empty list is a scan that looked.
    expect(filesCarrying(usesOf("validate-template-report"))).toContain(
      ".github/workflows/fleet-ci.yml",
    );
  });
});
