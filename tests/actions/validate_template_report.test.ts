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
// build-branch compare the fetch step makes. The comment is posted BEFORE
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
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  BUN_VERSION_FILE,
  TREE_DIR,
  VALIDATOR_DIR,
  VALIDATOR_SCRIPT,
  validatorOf,
} from "../../actions/validate-template-report/aligned_tree";
import { recordedBuildSha } from "../../actions/validate-template-report/build_sha";
import { type ChildExit, failureDetail, run } from "../../actions/validate-template-report/runtime";
import {
  classify,
  type Integrity,
  readVerdict,
  writeVerdict,
} from "../../actions/validate-template-report/verdict";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const ACTION = join(import.meta.dir, "../../actions/validate-template-report");
const MARKER = "<!-- repo-platform:validate-template -->";
const SHA = "6bf545284a2f8e32d82fdc663d4b3333f8fb37bf";
const REMEDY = "merge this repository's pending template sync PR";
const RUN_URL = "https://example.invalid/run/1";
const OPERATOR = "Vivswan/repo-platform";

// Serves the gate's gh calls and records every call so a scenario can
// assert the exact sequence. GH_FAIL fails every call before recording.
// The stub stands in for `gh api --jq`, so each fixture is already the
// filter's OUTPUT: the compare prints "<status> <ahead_by>", the comment
// listing the bare comment id (or nothing when the marker matched none),
// and the tarball endpoint streams the file GH_TARBALL names.
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
  *compare/*)
    echo "COMPARE $*" >> "$CALLS"
    if [ -n "\${GH_COMPARE_FAIL:-}" ]; then exit 1; fi
    printf '%s %s\\n' "\${GH_COMPARE_STATUS:-ahead}" "\${GH_AHEAD:-3}"
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
console.log("validated " + process.argv[2]);
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
  const root = mkdtempSync(join(tmpdir(), "validate-template-report-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  return { root, bin };
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

/** A fake validate-template action directory at `dir`. */
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

// The report step's own run block, executed as the runner would (its bash
// flags included): the one place `integrity` is set, on the bun path and on
// the no-bun fallback. A poisoned `bun` sits first on PATH, so the block
// passes only by running the recorded ACTION_BUN path, never bun by name.
const REPORT_STEP = (
  parseYaml(readFileSync(join(ACTION, "action.yml"), "utf8")).runs.steps as Record<
    string,
    unknown
  >[]
).find((step) => step.id === "report") as { run: string };

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
  writeFileSync(join(bin, "bun"), '#!/usr/bin/env bash\necho "bun by name: $*" >&2\nexit 97\n', {
    mode: 0o755,
  });
  const proc = boundedSpawnSync(
    ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", REPORT_STEP.run],
    {
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
    },
  );
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
    [
      "behind without a distance still says behind",
      { compare: "ahead", aheadBy: "" },
      {
        integrity: "success",
        body: bodyOf(PASSED, behind("")),
        calls: post(bodyOf(PASSED, behind(""))),
      },
    ],
    [
      "a compare the fetch step could not make on a clean verdict is named, not guessed",
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
    const root = mkdtempSync(join(tmpdir(), "verdict-"));
    expect(classify(exit, 300_000, files(root, findings, advisories))).toEqual(expected);
  });

  test("readVerdict rejects anything that is not a whole verdict", () => {
    const root = mkdtempSync(join(tmpdir(), "verdict-"));
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
  const failed = (stderr: string, timedOut = false) => ({
    exitCode: 2,
    stdout: "",
    stderr,
    timedOut,
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
    ["the deadline over any stderr", failed("tar: something", true), "timed out"],
  ])("%s", (_name, result, expected) => {
    expect(failureDetail(result)).toBe(expected);
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
    const root = mkdtempSync(join(tmpdir(), "build-sha-"));
    writeAnswers(root, answers);
    expect(recordedBuildSha(root)).toEqual(expected);
  });
});

// --- fetch_aligned.ts --------------------------------------------------------

interface FetchOptions {
  /** undefined = no .github/.copier-answers.yml at all. */
  answers?: string;
  /** false = the served build tree ships no validate-template action. */
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
  const proc = boundedSpawnSync(["bun", join(ACTION, "fetch_aligned.ts")], {
    cwd: repo,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "x",
      GH_TARBALL: tarball,
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
    /** The gh calls made, in order: the build-branch compare, then the fetch. */
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
  const compared = `COMPARE api repos/${OPERATOR}/compare/${SHA}...build --jq "\\(.status) \\(.ahead_by)"`;
  const fetched = `${compared}\nTARBALL api repos/${OPERATOR}/tarball/${SHA}`;
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
  const laidOut = (outputs: string) => ({
    exitCode: 0,
    outputs,
    calls: fetched,
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
      laidOut("compare=ahead\nahead-by=3\n"),
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
      refused(
        `could not confirm ${SHA} is on ${OPERATOR}'s build branch: gh: boom`,
        "",
        "compare=error\n",
      ),
    ],
    [
      "a compare that fails without a message still names the step that failed",
      { answers: `_commit: ${SHA}\n`, env: { GH_COMPARE_FAIL: "1" } },
      refused(
        `could not confirm ${SHA} is on ${OPERATOR}'s build branch: exit 1`,
        compared,
        "compare=error\n",
      ),
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
          `compare=${status}\nahead-by=0\n`,
        ),
      ],
    ),
    [
      "a fetch that fails after the compare passed fails closed with gh's own words",
      { answers: `_commit: ${SHA}\n`, env: { GH_TARBALL_FAIL: "1" } },
      refused(
        `could not fetch ${OPERATOR} at ${SHA}: gh: HTTP 404: Not Found`,
        fetched,
        "compare=ahead\nahead-by=3\n",
      ),
    ],
    [
      "a build tree without the validator fails closed",
      { answers: `_commit: ${SHA}\n`, validator: false },
      refused(
        `${OPERATOR} at ${SHA} ships no ${VALIDATOR_DIR}/${VALIDATOR_SCRIPT}`,
        fetched,
        "compare=ahead\nahead-by=3\n",
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
        "compare=ahead\nahead-by=3\n",
      ),
    ],
    [
      "a tree and verdict left by an earlier run are cleared, never judged by",
      { answers: `_commit: ${SHA}\n`, validator: false, stale: true },
      refused(
        `${OPERATOR} at ${SHA} ships no ${VALIDATOR_DIR}/${VALIDATOR_SCRIPT}`,
        fetched,
        "compare=ahead\nahead-by=3\n",
      ),
    ],
    [
      "a scratch root planted as a symlink is replaced, never written through",
      { answers: `_commit: ${SHA}\n`, symlinked: true },
      laidOut("compare=ahead\nahead-by=3\n"),
    ],
    // The unpacker's complaint runs several lines and its wording differs
    // per platform (bsdtar, GNU tar behind gzip); the reason is the fixed
    // prefix plus ONE non-empty line of it, whatever the tool prints.
    [
      "bytes that are not a tarball fail closed with the unpacker's first line",
      { answers: `_commit: ${SHA}\n`, corrupt: true },
      {
        exitCode: 1,
        outputs: "compare=ahead\nahead-by=3\n",
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
  const { root } = scratch();
  const repo = join(root, "repo");
  mkdirSync(repo);
  const alignedDir = join(root, "aligned");
  layValidator(validatorOf(alignedDir), { lockfile: opts.lockfile });
  const verdict = join(root, "verdict.json");
  const proc = boundedSpawnSync(["bun", join(ACTION, "judge_aligned.ts")], {
    cwd: repo,
    timeoutMs: 60_000,
    env: {
      ...process.env,
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

// --- action.yml --------------------------------------------------------------

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
      "fetch",
      "aligned-bun",
      "aligned-bun-retry",
      "aligned-bun-path",
      "integrity",
      "latest",
      "report",
    ]);
    // The operator repository is a constant, not an input: the latest
    // leg's `uses:` could never follow one.
    expect(Object.keys(action.inputs)).toEqual(["github-token"]);
    // ONE writer of integrity: the report step's output, never a step outcome.
    expect(action.outputs.integrity.value).toBe("${{ steps.report.outputs.integrity }}");
    expect(JSON.stringify(action.outputs)).not.toMatch(/steps\.(integrity|latest|fetch)\./);

    // Neither bun setup can end the action: both retries continue, and the
    // readiness of the action's bun is resolved once for every consumer.
    for (const id of ["setup-bun", "setup-bun-retry", "aligned-bun", "aligned-bun-retry"]) {
      expect(byId(id)?.["continue-on-error"]).toBe(true);
    }
    expect(byId("setup-bun-retry")?.if).toBe("steps.setup-bun.outcome == 'failure'");
    const actionBun = byId("action-bun");
    // Readiness has one truth, a bun on PATH at the pinned version, resolved
    // by one block for both buns (executed below); `ready` derives from it.
    expect(envOf(actionBun)).toEqual({ PIN_FILE: "${{ github.action_path }}/.bun-version" });
    const alignedBunPath = byId("aligned-bun-path");
    expect(alignedBunPath?.if).toBe("steps.fetch.outcome == 'success'");
    expect(String(alignedBunPath?.run)).toBe(String(actionBun?.run));
    const READY = "steps.action-bun.outputs.ready == 'true'";
    expect(byId("fetch")?.if).toBe(READY);
    expect(byId("latest")?.if).toBe(READY);

    // Every action script runs by the recorded absolute path, never `bun`
    // by name: later setups put other buns on PATH.
    const BUN_PATH = "${{ steps.action-bun.outputs.path }}";
    const fetch = byId("fetch");
    expect(String(fetch?.run)).toBe('"$ACTION_BUN" "${{ github.action_path }}/fetch_aligned.ts"');
    expect(envOf(fetch).ACTION_BUN).toBe(BUN_PATH);
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
      ["aligned-bun", "steps.fetch.outcome == 'success'"],
      ["aligned-bun-retry", "steps.aligned-bun.outcome == 'failure'"],
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

    const latest = byId("latest");
    expect(String(latest?.uses)).toBe("Vivswan/repo-platform/actions/validate-template@build");
    expect(latest?.["continue-on-error"]).toBe(true);
    const latestWith = latest?.with as Record<string, string>;

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
      LATEST_FINDINGS: latestWith["findings-file"],
      LATEST_ADVISORIES: latestWith["advisories-file"],
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

  // The one resolver block (both steps carry it), executed as the runner
  // would: a path is recorded exactly when an absolute executable on PATH
  // prints the pinned version AND exits 0, and `ready` derives from the
  // path. A bun that lies about its version, one found through a relative
  // PATH entry, another version, or no bun at all all read as no path.
  const BUN_DIR = realpathSync(join(process.execPath, ".."));
  const cases: [string, string, (dir: string) => { path: string; cwd?: string }, string][] = [
    [
      "the pinned version",
      Bun.version,
      () => ({ path: `${BUN_DIR}:/usr/bin:/bin` }),
      `path=${process.execPath}\nready=true\n`,
    ],
    [
      "another version",
      "0.0.1",
      () => ({ path: `${BUN_DIR}:/usr/bin:/bin` }),
      "path=\nready=false\n",
    ],
    ["no bun at all", Bun.version, () => ({ path: "/usr/bin:/bin" }), "path=\nready=false\n"],
    [
      "a bun printing the pinned version but exiting nonzero",
      Bun.version,
      (dir) => {
        writeFileSync(join(dir, "bun"), `#!/usr/bin/env bash\necho "${Bun.version}"\nexit 97\n`, {
          mode: 0o755,
        });
        return { path: `${dir}:/usr/bin:/bin` };
      },
      "path=\nready=false\n",
    ],
    [
      "the pinned version reached through a relative PATH entry",
      Bun.version,
      (dir) => {
        writeFileSync(join(dir, "bun"), `#!/usr/bin/env bash\necho "${Bun.version}"\n`, {
          mode: 0o755,
        });
        return { path: ".:/usr/bin:/bin", cwd: dir };
      },
      "path=\nready=false\n",
    ],
    ["an empty pin file", "", () => ({ path: `${BUN_DIR}:/usr/bin:/bin` }), "path=\nready=false\n"],
  ];
  test.each(cases)("a resolver with %s records %j", (_name, pinned, arrange, expected) => {
    const action = parseYaml(readFileSync(join(ACTION, "action.yml"), "utf8"));
    const step = (action.runs.steps as Record<string, unknown>[]).find(
      (s) => s.id === "action-bun",
    );
    const { root } = scratch();
    const stage = join(root, "stage");
    mkdirSync(stage);
    const { path, cwd } = arrange(stage);
    const pinFile = join(root, ".bun-version");
    writeFileSync(pinFile, pinned === "" ? "" : `${pinned}\n`);
    const outputs = join(root, "outputs.txt");
    writeFileSync(outputs, "");
    const proc = boundedSpawnSync(
      ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", String(step?.run)],
      { cwd, env: { PATH: path, PIN_FILE: pinFile, GITHUB_OUTPUT: outputs } },
    );
    expect([proc.exitCode, read(outputs)]).toEqual([0, expected]);
  });
});
