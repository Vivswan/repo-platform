// Behaviour tests for the validate-template-report action: the reporting
// logic that used to live as inline bash in the fleet ci.yml template runs
// as this action's freshness.ts and report.ts now, so the REAL scripts run
// here against a stubbed gh. Nothing touches the network. The rendered
// job's remaining shape (thin caller, fail-last re-raise) is pinned by
// tests/templates/validate_template_render.test.ts and the smoke harness.
//
// The contract under test is the split: INTEGRITY blocks (managed content
// changed out of band) while FRESHNESS only informs (behind the template is
// never the repo's fault), the comment is posted BEFORE the job fails so a
// blocking verdict is readable in the conversation, one comment is kept per
// PR rather than one per push, a clean-and-fresh run leaves no new comment
// but does clear a stale one, and every reporting or freshness failure
// degrades to a notice instead of taking the job down.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const ACTION = join(import.meta.dir, "../../actions/validate-template-report");
const MARKER = "<!-- repo-platform:validate-template -->";

// Serves the gate's gh calls and records writes so a test can assert which
// API call happened. GH_FAIL fails every call. The stub stands in for
// `gh api --jq`, so the comment-listing fixture is already the filter's
// OUTPUT: the bare comment id, or nothing when the marker matched none.
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
case "$*" in
  *--method\\ PATCH*) echo "PATCH $*" >> "$CALLS"; exit 0 ;;
  *--method\\ POST*) echo "POST $*" >> "$CALLS"; exit 0 ;;
  *branches/build*) printf '%s\\n' "\${GH_TIP:-}"; exit 0 ;;
  *compare/*)
    if [ -n "\${GH_COMPARE_FAIL:-}" ]; then exit 1; fi
    printf '%s\\n' "\${GH_AHEAD:-}"
    exit 0
    ;;
esac
echo "LIST" >> "$CALLS"
cat "$GH_COMMENTS_ID"
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

interface ReportOptions {
  /** undefined = the validator never wrote one; "" = clean tree; else findings. */
  findings?: string;
  event?: string;
  /** The id the marker search resolves to, or "" for no existing comment. */
  existing?: string;
  freshness?: "fresh" | "behind" | "skipped" | "";
  /** The validator's NON-blocking stream, written to its own file. */
  advisories?: string;
  env?: Record<string, string>;
}

function runReport(opts: ReportOptions = {}) {
  const { root, bin } = scratch();
  const findingsPath = join(root, "findings.md");
  if (opts.findings !== undefined) writeFileSync(findingsPath, opts.findings);
  const advisoriesPath = join(root, "advisories.md");
  writeFileSync(advisoriesPath, opts.advisories ?? "");
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
      EVENT_NAME: opts.event ?? "pull_request",
      ADVISORIES: advisoriesPath,
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
  if (opts.answers !== undefined) {
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github/.copier-answers.yml"), opts.answers);
  }
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

describe("the action's reporting script", () => {
  test("an integrity finding posts the findings and says it blocks", () => {
    const r = runReport({ findings: "#### Errors (1)\n\n- ci.yml drifted\n" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("POST");
    expect(r.summary).toContain("ci.yml drifted");
    expect(r.summary).toContain("This FAILS the check.");
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

describe("the action's freshness script", () => {
  // Every run is judged whole: exit code, the state handed to report.ts,
  // the fragment it splices (only when behind), and the script's own
  // output (a notice only when it skips). The fragment and notice texts
  // are exact - they are what the PR comment shows.
  const behind = (distance: string) =>
    `#### Freshness\n\nThis repository is ${distance} (recorded \`abc1234\`, tip \`def5678\`). The next sync PR updates the managed files; nothing to do here.\n`;
  const skipped = (reason: string) => ({
    exitCode: 0,
    state: "state=skipped",
    fragment: "",
    output: `::notice::${reason} Skipping the freshness check.\n`,
  });
  const fresh = { exitCode: 0, state: "state=fresh", fragment: "", output: "" };
  const NO_COMMIT = "No _commit is recorded in .github/.copier-answers.yml.";
  const runs: [string, FreshnessOptions, ReturnType<typeof runFreshness>][] = [
    [
      "a tip extending the recorded short sha is fresh, with nothing to splice",
      { answers: "_commit: abc1234\n", env: { GH_TIP: "abc1234def5678" } },
      fresh,
    ],
    [
      "a quoted recorded sha still matches (YAML quotes numeric-looking shas)",
      { answers: '_commit: "1234567"\n', env: { GH_TIP: "1234567890abcd" } },
      fresh,
    ],
    [
      "behind with a resolvable distance names the commit count",
      { answers: "_commit: abc1234\n", env: { GH_TIP: "def5678901234", GH_AHEAD: "3" } },
      {
        exitCode: 0,
        state: "state=behind",
        fragment: behind("behind the build branch by 3 commit(s)"),
        output: "",
      },
    ],
    [
      "a failed compare still reports behind, just without the number",
      { answers: "_commit: abc1234\n", env: { GH_TIP: "def5678901234", GH_COMPARE_FAIL: "1" } },
      {
        exitCode: 0,
        state: "state=behind",
        fragment: behind("behind the build branch"),
        output: "",
      },
    ],
    ["no answers file skips with a notice, never failing", {}, skipped(NO_COMMIT)],
    [
      "answers without a _commit line skip the same way",
      { answers: "_src_path: gh:Vivswan/repo-platform\n" },
      skipped(NO_COMMIT),
    ],
    [
      "a failed branch read skips with a notice instead of going red",
      { answers: "_commit: abc1234\n", env: { GH_FAIL: "1" } },
      skipped(
        "Could not read Vivswan/repo-platform's build branch (network, or a private operator repo this token cannot read).",
      ),
    ],
    [
      "an empty tip answer skips rather than comparing against nothing",
      { answers: "_commit: abc1234\n", env: { GH_TIP: "" } },
      skipped("Vivswan/repo-platform's build branch reported no commit."),
    ],
  ];
  test.each(runs)("%s", (_reason, opts, expected) => {
    expect(runFreshness(opts)).toEqual(expected);
  });
});

describe("the action's wiring", () => {
  // The deferred-verdict plumbing the behaviour tests cannot see: the
  // wrapped integrity action keeps its own exit code but the step defers
  // it, and the action's output hands that outcome to the caller's
  // fail-last step.
  test("action.yml wraps validate-template deferred and exposes its outcome", () => {
    const action = parseYaml(readFileSync(join(ACTION, "action.yml"), "utf8"));
    const steps: Record<string, unknown>[] = action.runs.steps;
    const integrity = steps.find((step) => step.id === "integrity");
    expect(String(integrity?.uses)).toBe("Vivswan/repo-platform/actions/validate-template@build");
    expect(integrity?.["continue-on-error"]).toBe(true);
    const withBlock = integrity?.with as Record<string, string>;
    expect(withBlock["findings-file"]).toContain("validate-findings.md");
    expect(withBlock["advisories-file"]).toContain("validate-advisories.md");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    expect(action.outputs.integrity.value).toBe("${{ steps.integrity.outcome }}");
    // The freshness leg can never fail the job, and stays a ref compare
    // against the operator's build branch: a render here would cost
    // every fleet repo a copier run per push.
    const freshness = steps.find((step) => step.id === "freshness");
    expect(freshness?.["continue-on-error"]).toBe(true);
    expect(String(freshness?.run)).toContain("freshness.ts");
    const sources = ["freshness.ts", "report.ts"].map((name) =>
      readFileSync(join(ACTION, name), "utf8"),
    );
    for (const source of sources) expect(source).not.toMatch(/^\s*copier\s/m);
    expect(sources[0]).toContain("/branches/build");
  });
});
