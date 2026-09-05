// Behaviour tests for the validate-template-report action: the REAL
// scripts run here against a stubbed gh. Nothing touches the network. The
// rendered job's remaining shape (thin caller, fail-last re-raise) is
// pinned by tests/templates/fleet_ci_shape.test.ts and the smoke harness.
//
// The contract under test is the three-leg split: INTEGRITY blocks
// (managed content changed out of band, judged by the validator of the
// template the repository was rendered from - fetched at the FULL build
// sha its `_commit` records, never resolved from a short one), the LATEST
// pass only warns (rules the next sync brings, never said twice), and
// FRESHNESS only informs (behind the template is never the repo's fault).
// The comment is posted BEFORE the job fails so a blocking verdict is
// readable in the conversation, one comment is kept per PR rather than
// one per push, a clean-and-fresh run leaves no new comment but does
// clear a stale one, and every reporting or freshness failure degrades to
// a notice instead of taking the job down.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { recordedBuildSha } from "../../actions/validate-template-report/build_sha";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const ACTION = join(import.meta.dir, "../../actions/validate-template-report");
const MARKER = "<!-- repo-platform:validate-template -->";
const SHA = "6bf545284a2f8e32d82fdc663d4b3333f8fb37bf";
const TIP = "def5678901234def5678901234def5678901234d";
const REMEDY = "merge this repository's pending template sync PR.";

// Serves the gate's gh calls and records writes so a test can assert which
// API call happened. GH_FAIL fails every call. The stub stands in for
// `gh api --jq`, so the comment-listing fixture is already the filter's
// OUTPUT: the bare comment id, or nothing when the marker matched none.
// The tarball endpoint streams the fixture GH_TARBALL names.
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
  *branches/build*) printf '%s\\n' "\${GH_TIP:-}"; exit 0 ;;
  *compare/*)
    echo "COMPARE $*" >> "$CALLS"
    if [ -n "\${GH_COMPARE_FAIL:-}" ]; then exit 1; fi
    case "$*" in
      *.status*) printf '%s\\n' "\${GH_COMPARE_STATUS:-ahead}" ;;
      *) printf '%s\\n' "\${GH_AHEAD:-}" ;;
    esac
    exit 0
    ;;
esac
echo "LIST" >> "$CALLS"
cat "$GH_COMMENTS_ID"
`;

// Stands in for the build tree's validate_generated_files.ts: writes the
// findings the test dictates and exits as told, so the aligned leg's
// routing and verdict propagation are what the test sees.
const fakeValidator = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.FINDINGS_FILE, process.env.FAKE_FINDINGS ?? "");
writeFileSync(process.env.ADVISORIES_FILE, "");
console.log("validated " + process.argv[2]);
process.exit(Number(process.env.FAKE_EXIT ?? "0"));
`;

const read = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

function scratch(): { root: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "validate-template-report-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  return { root, bin };
}

function writeAnswers(root: string, answers: string | undefined): void {
  if (answers === undefined) return;
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, ".github/.copier-answers.yml"), answers);
}

interface ReportOptions {
  /** undefined = the validator never wrote one; "" = clean tree; else findings. */
  findings?: string;
  event?: string;
  /** The id the marker search resolves to, or "" for no existing comment. */
  existing?: string;
  freshness?: "fresh" | "behind" | "skipped" | "";
  /** The validator's NON-blocking stream, written to its own file. */
  advisories?: string;
  /** Why aligned.ts never ran the validator (its `reason` output). */
  reason?: string;
  /** The build tip validator's pair; null = that step never wrote its findings. */
  latestFindings?: string | null;
  latestAdvisories?: string;
  env?: Record<string, string>;
}

function runReport(opts: ReportOptions = {}) {
  const { root, bin } = scratch();
  const findingsPath = join(root, "findings.md");
  if (opts.findings !== undefined) writeFileSync(findingsPath, opts.findings);
  const advisoriesPath = join(root, "advisories.md");
  writeFileSync(advisoriesPath, opts.advisories ?? "");
  const latestFindingsPath = join(root, "latest-findings.md");
  if (opts.latestFindings !== null) writeFileSync(latestFindingsPath, opts.latestFindings ?? "");
  const latestAdvisoriesPath = join(root, "latest-advisories.md");
  writeFileSync(latestAdvisoriesPath, opts.latestAdvisories ?? "");
  const freshnessPath = join(root, "freshness.md");
  writeFileSync(freshnessPath, "#### Freshness\n\nbehind the build branch by 3 commit(s).\n");
  const calls = join(root, "calls.txt");
  const summary = join(root, "summary.md");
  writeFileSync(summary, "");
  const listing = join(root, "comments.json");
  writeFileSync(listing, opts.existing === undefined ? "" : `${opts.existing}\n`);
  const proc = boundedSpawnSync(["bun", join(ACTION, "report.ts")], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/managed-repo",
      GITHUB_STEP_SUMMARY: summary,
      GH_TOKEN: "x",
      FINDINGS: findingsPath,
      ADVISORIES: advisoriesPath,
      ALIGNED_REASON: opts.reason ?? "",
      LATEST_FINDINGS: latestFindingsPath,
      LATEST_ADVISORIES: latestAdvisoriesPath,
      EVENT_NAME: opts.event ?? "pull_request",
      FRESHNESS: freshnessPath,
      FRESHNESS_STATE: opts.freshness ?? "fresh",
      PR_NUMBER: "12",
      RUN_URL: "https://example.invalid/run/1",
      CALLS: calls,
      GH_COMMENTS_ID: listing,
      ...opts.env,
    },
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout + proc.stderr,
    calls: read(calls),
    summary: read(summary),
  };
}

interface FreshnessOptions {
  /** undefined = no .github/.copier-answers.yml at all. */
  answers?: string;
  env?: Record<string, string>;
}

function runFreshness(opts: FreshnessOptions = {}) {
  const { root, bin } = scratch();
  writeAnswers(root, opts.answers);
  const fragment = join(root, "freshness.md");
  const outputs = join(root, "outputs.txt");
  writeFileSync(outputs, "");
  const proc = boundedSpawnSync(["bun", join(ACTION, "freshness.ts")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "x",
      TEMPLATE_REPO: "Vivswan/repo-platform",
      FRESHNESS: fragment,
      GITHUB_OUTPUT: outputs,
      CALLS: join(root, "calls.txt"),
      GH_COMMENTS_ID: join(root, "comments.json"),
      ...opts.env,
    },
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout + proc.stderr,
    state: read(outputs).trim(),
    fragment: read(fragment),
  };
}

interface AlignedOptions {
  /** undefined = no .github/.copier-answers.yml at all. */
  answers?: string;
  /** false = the served build tree ships no validate-template action. */
  validator?: boolean;
  /** A bun.lock to ship beside the fake validator (none by default). */
  lockfile?: string;
  /** true = gh serves bytes that are not a tarball. */
  corrupt?: boolean;
  /** true = a validator from an earlier run already sits in ALIGNED_DIR. */
  stale?: boolean;
  env?: Record<string, string>;
}

/** A build-tree tarball the gh stub serves: GitHub's shape (one top-level
 *  directory) around the fake validator. */
function buildTarball(root: string, opts: AlignedOptions): string {
  const TOP = "Vivswan-repo-platform-6bf5452";
  const top = join(root, "served", TOP);
  mkdirSync(join(top, "actions", "shared"), { recursive: true });
  writeFileSync(join(top, "copier.yml"), "_subdirectory: template\n");
  if (opts.validator ?? true) {
    const dir = join(top, "actions", "validate-template");
    mkdirSync(dir);
    writeFileSync(join(dir, "validate_generated_files.ts"), fakeValidator);
    writeFileSync(join(dir, "package.json"), '{"name":"validate-template","private":true}\n');
    if (opts.lockfile !== undefined) writeFileSync(join(dir, "bun.lock"), opts.lockfile);
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

function runAligned(opts: AlignedOptions = {}) {
  const { root, bin } = scratch();
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeAnswers(repo, opts.answers);
  const tarball = buildTarball(root, opts);
  const outputs = join(root, "outputs.txt");
  writeFileSync(outputs, "");
  // Pre-seeded leftovers: a run that never reaches the validator must
  // leave no findings file, and a stale tree must not be judged by.
  const alignedDir = join(root, "aligned");
  const findings = join(root, "aligned-findings.md");
  const advisories = join(root, "aligned-advisories.md");
  writeFileSync(findings, "#### Errors (1)\n\n- stale finding from an earlier run\n");
  writeFileSync(advisories, "#### Advisories (1)\n\n- stale advisory from an earlier run\n");
  if (opts.stale) {
    const staleValidator = join(alignedDir, "tree", "actions", "validate-template");
    mkdirSync(staleValidator, { recursive: true });
    writeFileSync(join(staleValidator, "validate_generated_files.ts"), fakeValidator);
    writeFileSync(join(staleValidator, "package.json"), '{"name":"stale","private":true}\n');
  }
  const calls = join(root, "calls.txt");
  const proc = boundedSpawnSync(["bun", join(ACTION, "aligned.ts")], {
    cwd: repo,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "x",
      GH_TARBALL: tarball,
      TEMPLATE_REPO: "Vivswan/repo-platform",
      ALIGNED_DIR: alignedDir,
      FINDINGS_FILE: findings,
      ADVISORIES_FILE: advisories,
      GITHUB_OUTPUT: outputs,
      CALLS: calls,
      ...opts.env,
    },
  });
  return {
    exitCode: proc.exitCode,
    reason: read(outputs).trim(),
    /** The gh calls made, in order: the build-branch compare, then the fetch. */
    calls: read(calls).trim(),
    /** null = the validator never wrote them. */
    findings: existsSync(findings) ? read(findings) : null,
    advisories: existsSync(advisories) ? read(advisories) : null,
    // realpath: the script resolves its cwd, and tmpdir may be a symlink.
    judged: (proc.stdout + proc.stderr).includes(`validated ${realpathSync(repo)}`),
    errors: (proc.stdout + proc.stderr).match(/^::error::.*$/gm) ?? [],
  };
}

describe("the action's reporting script", () => {
  test("an integrity finding posts the findings and says it blocks", () => {
    const r = runReport({ findings: "#### Errors (1)\n\n- ci.yml drifted\n" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("POST");
    expect(r.summary).toContain("ci.yml drifted");
    expect(r.summary).toContain("This FAILS the check.");
  });

  test("a refused _commit is reported as not judged, and blocks", () => {
    const reason = `_commit 'abc1234' is not a full build sha; ${REMEDY}`;
    const r = runReport({ reason });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("POST");
    expect(r.summary).toContain(`#### Integrity\n\nNot judged: ${reason} This FAILS the check.`);
    expect(r.summary).not.toContain("exited before reporting");
  });

  test("a clean tree that is BEHIND comments about freshness without blocking", () => {
    const r = runReport({ findings: "", freshness: "behind" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("POST");
    expect(r.summary).toContain("Passed");
    expect(r.summary).toContain("behind the build branch");
    expect(r.summary).not.toContain("This FAILS the check.");
    // The comment carries the stable marker so the next run finds it.
    expect(r.summary).toContain(MARKER);
  });

  // Advisories are the validator's non-failing stream. Folding them into
  // the integrity verdict had a clean repository reading as blocked.
  test("advisories are reported without ever claiming to block", () => {
    const r = runReport({
      findings: "",
      advisories: "#### Advisories (1)\n\n- consider a codeql job\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain("consider a codeql job");
    expect(r.summary).toContain("Passed");
    expect(r.summary).not.toContain("This FAILS the check.");
    // Worth a comment, since there is something to say.
    expect(r.calls).toContain("POST");
  });

  // The build tip's validator knows rules the repository's pending sync
  // has not delivered; they are warnings on a passing check, and a line
  // the aligned validator already reported is not repeated under them.
  test("the latest validator's findings warn under their own heading, deduplicated", () => {
    const r = runReport({
      findings: "#### Errors (1)\n\n- ci.yml drifted\n",
      advisories: "#### Advisories (1)\n\n- consider a codeql job\n",
      latestFindings:
        "#### Errors (2)\n\n- ci.yml drifted\n- .github/SECURITY.md is missing - the template always generates it\n",
      latestAdvisories:
        "#### Advisories (2)\n\n- consider a codeql job\n- pin actions/setup-node\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain(
      "#### After your next sync\n\nThe current template's validator also reports the following; the next sync PR brings these rules, and they do not fail this check.\n\n- .github/SECURITY.md is missing - the template always generates it\n- pin actions/setup-node\n\n#### Freshness",
    );
    // Said once, in the integrity section, not again below.
    expect(r.summary.match(/ci\.yml drifted/g)).toHaveLength(1);
    expect(r.summary.match(/consider a codeql job/g)).toHaveLength(1);
  });

  test("latest-only findings on a clean tree warn, comment, and still pass", () => {
    const r = runReport({
      findings: "",
      latestFindings: "#### Errors (1)\n\n- .github/SECURITY.md is missing\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain("Passed");
    expect(r.summary).toContain("#### After your next sync");
    expect(r.summary).toContain("- .github/SECURITY.md is missing");
    expect(r.summary).not.toContain("This FAILS the check.");
    expect(r.calls).toContain("POST");
  });

  test("a latest pass with nothing new adds no section and no comment", () => {
    const echoed = "#### Errors (1)\n\n- ci.yml drifted\n";
    const same = runReport({ findings: echoed, latestFindings: echoed });
    expect(same.summary).not.toContain("After your next sync");
    const clean = runReport({ findings: "", latestFindings: "" });
    expect(clean.exitCode).toBe(0);
    expect(clean.summary).not.toContain("After your next sync");
    expect(clean.calls).not.toContain("POST");
  });

  // Absent is not empty: a latest step that never wrote its findings is a
  // setup failure, said as a warning on a check it cannot fail.
  test("a latest pass that never reported says so without blocking", () => {
    const r = runReport({ findings: "", latestFindings: null });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain(
      "#### After your next sync\n\nThe current template's validator exited before reporting. See the [run log](https://example.invalid/run/1).",
    );
    expect(r.summary).toContain("Passed");
    expect(r.summary).not.toContain("This FAILS the check.");
    expect(r.calls).toContain("POST");
  });

  test("clean and fresh: no new comment at all", () => {
    const r = runReport({ findings: "", freshness: "fresh" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).not.toContain("POST");
    expect(r.calls).not.toContain("PATCH");
    expect(r.summary).toContain("Up to date with the build branch.");
  });

  // The PATCH must aim at the comment the marker search found: the id is
  // pinned up to the next argument, so a wrong or padded id is red.
  const patchOf = (id: string) =>
    new RegExp(
      `^PATCH api --method PATCH repos/Vivswan/managed-repo/issues/comments/${id} -f body=`,
      "m",
    );

  test("clean and fresh still clears a comment a previous run left behind", () => {
    const r = runReport({ findings: "", freshness: "fresh", existing: "555" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toMatch(patchOf("555"));
    expect(r.calls).not.toContain("POST");
  });

  test("an existing comment is updated, never duplicated", () => {
    const r = runReport({ findings: "#### Errors (1)\n\n- drift\n", existing: "77" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toMatch(patchOf("77"));
    expect(r.calls).not.toContain("POST");
  });

  test("a skipped freshness check says so instead of claiming up to date", () => {
    const r = runReport({ findings: "", freshness: "skipped" });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain("Not checked this run");
    expect(r.summary).not.toContain("Up to date");
  });

  test("a push writes the summary and never touches the comments API", () => {
    const r = runReport({ findings: "", freshness: "behind", event: "push" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toBe("");
    expect(r.summary).toContain("behind the build branch");
  });

  test("a missing findings file reports that the validator never ran", () => {
    const r = runReport({});
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain("exited before reporting");
    expect(r.summary).not.toContain("Passed");
  });

  test("a comments API failure degrades to a warning, never failing the step", () => {
    const r = runReport({ findings: "#### Errors (1)\n\n- drift\n", env: { GH_FAIL: "1" } });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::");
    expect(r.summary).toContain("drift");
  });
});

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

describe("the action's aligned validator script", () => {
  // Judged whole: exit code, the `reason` output (only when the validator
  // never ran), the gh calls made (the exact build-branch compare, then
  // the fetch at the recorded sha), the findings file the validator wrote
  // (null when it never ran - the harness pre-seeds a stale one, so null
  // also proves the clearing), and whether the fake validator judged the
  // repository at all.
  const compared = `COMPARE api repos/Vivswan/repo-platform/compare/${SHA}...build --jq .status`;
  const fetched = `${compared}\nTARBALL api repos/Vivswan/repo-platform/tarball/${SHA}`;
  const refused = (reason: string, calls = "") => ({
    exitCode: 1,
    reason: `reason=${reason}`,
    calls,
    findings: null,
    advisories: null,
    judged: false,
    errors: [`::error::${reason}`],
  });
  const notJudged = (reasonPrefix: string) => ({
    exitCode: 1,
    reason: expect.stringMatching(new RegExp(`^reason=${reasonPrefix}: .+$`)),
    calls: fetched,
    findings: null,
    advisories: null,
    judged: false,
    errors: [expect.stringMatching(new RegExp(`^::error::${reasonPrefix}: `))],
  });
  const runs: [string, AlignedOptions, ReturnType<typeof runAligned>][] = [
    // Both statuses under which the build branch contains the sha.
    ...(["ahead", "identical"] as const).map(
      (status): [string, AlignedOptions, ReturnType<typeof runAligned>] => [
        `a full sha the build branch contains (compare: ${status}) fetches that tree; clean is the validator's exit 0`,
        { answers: `_commit: ${SHA}\n`, env: { GH_COMPARE_STATUS: status } },
        {
          exitCode: 0,
          reason: "",
          calls: fetched,
          findings: "",
          advisories: "",
          judged: true,
          errors: [],
        },
      ],
    ),
    [
      "a quoted full sha is judged the same, and findings ride the validator's exit 1",
      {
        answers: `_commit: "${SHA}"\n`,
        env: { FAKE_FINDINGS: "#### Errors (1)\n\n- ci.yml drifted\n", FAKE_EXIT: "1" },
      },
      {
        exitCode: 1,
        reason: "",
        calls: fetched,
        findings: "#### Errors (1)\n\n- ci.yml drifted\n",
        advisories: "",
        judged: true,
        errors: [],
      },
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
      refused(`could not confirm ${SHA} is on Vivswan/repo-platform's build branch: gh: boom`),
    ],
    [
      "a compare that fails without a message still names the step that failed",
      { answers: `_commit: ${SHA}\n`, env: { GH_COMPARE_FAIL: "1" } },
      refused(
        `could not confirm ${SHA} is on Vivswan/repo-platform's build branch: exit 1`,
        compared,
      ),
    ],
    // The tarball endpoint would serve any commit in the repository's
    // network, and the answers file is PR-editable: only a commit the
    // protected build branch already contains may run.
    ...(["diverged", "behind"] as const).map(
      (status): [string, AlignedOptions, ReturnType<typeof runAligned>] => [
        `a sha the build branch does not contain (compare: ${status}) is refused unfetched`,
        { answers: `_commit: ${SHA}\n`, env: { GH_COMPARE_STATUS: status } },
        refused(
          `_commit ${SHA} is not a published commit of Vivswan/repo-platform's build branch (compare: ${status})`,
          compared,
        ),
      ],
    ),
    [
      "a fetch that fails after the compare passed fails closed with gh's own words",
      { answers: `_commit: ${SHA}\n`, env: { GH_TARBALL_FAIL: "1" } },
      refused(`could not fetch Vivswan/repo-platform at ${SHA}: gh: HTTP 404: Not Found`, fetched),
    ],
    [
      "a build tree without the validator fails closed",
      { answers: `_commit: ${SHA}\n`, validator: false },
      refused(
        `Vivswan/repo-platform at ${SHA} ships no actions/validate-template/validate_generated_files.ts`,
        fetched,
      ),
    ],
    [
      "a validator left by an earlier run is cleared, never judged by",
      { answers: `_commit: ${SHA}\n`, validator: false, stale: true },
      refused(
        `Vivswan/repo-platform at ${SHA} ships no actions/validate-template/validate_generated_files.ts`,
        fetched,
      ),
    ],
    // tar's complaint is two lines; the reason output stays one.
    [
      "bytes that are not a tarball fail closed with tar's first line",
      { answers: `_commit: ${SHA}\n`, corrupt: true },
      notJudged(`could not unpack Vivswan/repo-platform at ${SHA}`),
    ],
    [
      "a lockfile the frozen install rejects fails closed before the validator runs",
      { answers: `_commit: ${SHA}\n`, lockfile: "not a lockfile {\n" },
      notJudged(`could not install the validator's dependencies at ${SHA}`),
    ],
  ];
  test.each(runs)("%s", (_name, opts, expected) => {
    expect(runAligned(opts)).toEqual(expected);
  });
});

describe("the action's freshness script", () => {
  // Every run is judged whole: exit code, the state handed to report.ts,
  // the fragment it splices (only when behind), and the script's own
  // output (a notice only when it skips). The fragment and notice texts
  // are exact - they are what the PR comment shows.
  const behind = (distance: string) =>
    `#### Freshness\n\nThis repository is ${distance} (recorded \`6bf5452\`, tip \`def5678\`). The next sync PR updates the managed files; nothing to do here.\n`;
  const skipped = (reason: string) => ({
    exitCode: 0,
    state: "state=skipped",
    fragment: "",
    output: `::notice::${reason} Skipping the freshness check.\n`,
  });
  const fresh = { exitCode: 0, state: "state=fresh", fragment: "", output: "" };
  const runs: [string, FreshnessOptions, ReturnType<typeof runFreshness>][] = [
    [
      "a tip equal to the recorded sha is fresh, with nothing to splice",
      { answers: `_commit: ${SHA}\n`, env: { GH_TIP: SHA } },
      fresh,
    ],
    [
      "a quoted recorded sha still matches (YAML quotes numeric-looking shas)",
      { answers: `_commit: "${SHA}"\n`, env: { GH_TIP: SHA } },
      fresh,
    ],
    [
      "behind with a resolvable distance names the commit count",
      { answers: `_commit: ${SHA}\n`, env: { GH_TIP: TIP, GH_AHEAD: "3" } },
      {
        exitCode: 0,
        state: "state=behind",
        fragment: behind("behind the build branch by 3 commit(s)"),
        output: "",
      },
    ],
    [
      "a failed compare still reports behind, just without the number",
      { answers: `_commit: ${SHA}\n`, env: { GH_TIP: TIP, GH_COMPARE_FAIL: "1" } },
      {
        exitCode: 0,
        state: "state=behind",
        fragment: behind("behind the build branch"),
        output: "",
      },
    ],
    // The integrity leg already failed the check on these; freshness only
    // steps aside so the refusal is not said twice.
    [
      "no answers file skips with the refusal, never failing",
      {},
      skipped(`.github/.copier-answers.yml records no _commit; ${REMEDY}`),
    ],
    [
      "a short recorded sha skips rather than prefix-matching the tip",
      { answers: "_commit: 6bf5452\n", env: { GH_TIP: SHA } },
      skipped(`_commit '6bf5452' is not a full build sha; ${REMEDY}`),
    ],
    [
      "a failed branch read skips with a notice instead of going red",
      { answers: `_commit: ${SHA}\n`, env: { GH_FAIL: "1" } },
      skipped(
        "Could not read Vivswan/repo-platform's build branch (network, or a private operator repo this token cannot read).",
      ),
    ],
    [
      "an empty tip answer skips rather than comparing against nothing",
      { answers: `_commit: ${SHA}\n`, env: { GH_TIP: "" } },
      skipped("Vivswan/repo-platform's build branch reported no commit."),
    ],
  ];
  test.each(runs)("%s", (_reason, opts, expected) => {
    expect(runFreshness(opts)).toEqual(expected);
  });
});

describe("the action's wiring", () => {
  // The deferred-verdict plumbing the behaviour tests cannot see: the
  // aligned step keeps its own exit code but defers it, the latest pass
  // is deferred too and read by nothing, and the action's output hands
  // the aligned outcome to the caller's fail-last step.
  test("action.yml runs the aligned validator as the verdict and the latest one as advice", () => {
    const action = parseYaml(readFileSync(join(ACTION, "action.yml"), "utf8"));
    const steps: Record<string, unknown>[] = action.runs.steps;
    const integrity = steps.find((step) => step.id === "integrity");
    expect(String(integrity?.run)).toContain("aligned.ts");
    expect(integrity?.["continue-on-error"]).toBe(true);
    const alignedEnv = integrity?.env as Record<string, string>;
    expect(alignedEnv.FINDINGS_FILE).toContain("aligned-findings.md");
    expect(alignedEnv.ADVISORIES_FILE).toContain("aligned-advisories.md");
    expect(alignedEnv.TEMPLATE_REPO).toBe("${{ inputs.template-repo }}");
    expect(action.outputs.integrity.value).toBe("${{ steps.integrity.outcome }}");

    const latest = steps.find((step) => step.id === "latest");
    expect(String(latest?.uses)).toBe("Vivswan/repo-platform/actions/validate-template@build");
    expect(latest?.["continue-on-error"]).toBe(true);
    const latestWith = latest?.with as Record<string, string>;
    expect(latestWith["findings-file"]).toContain("latest-findings.md");
    expect(latestWith["advisories-file"]).toContain("latest-advisories.md");
    expect(JSON.stringify(action.outputs)).not.toContain("steps.latest");

    // report.ts reads the two pairs from the same paths the legs wrote,
    // and the aligned refusal reason from the deferred step's output.
    const report = steps.find((step) => String(step.run).includes("report.ts"));
    const reportEnv = report?.env as Record<string, string>;
    expect(reportEnv.FINDINGS).toBe(alignedEnv.FINDINGS_FILE);
    expect(reportEnv.ADVISORIES).toBe(alignedEnv.ADVISORIES_FILE);
    expect(reportEnv.LATEST_FINDINGS).toBe(latestWith["findings-file"]);
    expect(reportEnv.LATEST_ADVISORIES).toBe(latestWith["advisories-file"]);
    expect(reportEnv.ALIGNED_REASON).toBe("${{ steps.integrity.outputs.reason }}");

    // The freshness leg can never fail the job, and stays a ref compare
    // against the operator's build branch: a render here would cost
    // every fleet repo a copier run per push.
    const freshness = steps.find((step) => step.id === "freshness");
    expect(freshness?.["continue-on-error"]).toBe(true);
    expect(String(freshness?.run)).toContain("freshness.ts");
    const sources = ["aligned.ts", "freshness.ts", "report.ts"].map((name) =>
      readFileSync(join(ACTION, name), "utf8"),
    );
    for (const source of sources) expect(source).not.toMatch(/^\s*copier\s/m);
    expect(sources[1]).toContain("/branches/build");
  });
});
