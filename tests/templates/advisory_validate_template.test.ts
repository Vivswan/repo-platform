// Behaviour tests for the validate-template job the template lands in every
// fleet repo. Like the Copilot gate, the reporting is inline bash (a generated
// repo has no repo-platform scripts), so these run the REAL bytes lifted out of
// a committed golden render, against a stubbed gh. Nothing here touches the
// network.
//
// The contract under test is the split: INTEGRITY blocks (managed content
// changed out of band) while FRESHNESS only informs (behind the template is
// never the repo's fault), the comment is posted BEFORE the job fails so a
// blocking verdict is readable in the conversation, one comment is kept per PR
// rather than one per push, a clean-and-fresh run leaves no new comment but
// does clear a stale one, and every reporting or freshness failure degrades to
// a notice instead of taking the job down.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const RENDERS = join(import.meta.dir, "../golden-renders");
const GOLDENS = ["minimal", "all-modules", "uv-no-release-please"];
const MARKER = "<!-- repo-platform:validate-template -->";

interface Step {
  uses?: string;
  id?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
  "continue-on-error"?: boolean;
}
interface Job {
  permissions?: Record<string, string>;
  steps?: Step[];
}

function ci(golden: string): { jobs: Record<string, Job & { needs?: string[] }> } {
  return parseYaml(readFileSync(join(RENDERS, golden, ".github/workflows/ci.yml"), "utf8"));
}

function stepRun(golden: string, index: number, label: string): Step {
  const step = ci(golden).jobs["validate-template"]?.steps?.[index];
  if (step?.run === undefined) throw new Error(`${golden}: no ${label} step`);
  return step;
}
const freshnessStep = (g: string): Step => stepRun(g, 2, "freshness");
const reportStep = (g: string): Step => stepRun(g, 3, "report");

// Serves the comment listing and records writes so a test can assert which
// API call happened. GH_FAIL fails every call.
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
case "$*" in
  *--method\\ PATCH*) echo "PATCH $*" >> "$CALLS"; exit 0 ;;
  *--method\\ POST*) echo "POST $*" >> "$CALLS"; exit 0 ;;
esac
echo "LIST" >> "$CALLS"
cat "$GH_COMMENTS_ID"
`;

// coreutils timeout is Linux-only; the workflow only runs on ubuntu-latest.
const timeoutStub = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ''|*[!0-9]*) echo "timeout stub: '$1' is not a deadline" >&2; exit 64 ;;
esac
shift
exec "$@"
`;

interface Options {
  /** undefined = the action never wrote one; "" = clean tree; else findings. */
  findings?: string;
  event?: string;
  /** The id the marker search resolves to, or "" for no existing comment. */
  existing?: string;
  freshness?: "fresh" | "behind" | "skipped" | "";
  /** The action's NON-blocking stream, written to its own file. */
  advisories?: string;
  integrity?: "success" | "failure";
  env?: Record<string, string>;
}

function run(opts: Options = {}, golden = "minimal") {
  const root = mkdtempSync(join(tmpdir(), "advisory-validate-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  writeFileSync(join(bin, "timeout"), timeoutStub, { mode: 0o755 });
  const script = join(root, "report.sh");
  writeFileSync(script, reportStep(golden).run ?? "");
  const findingsPath = join(root, "findings.md");
  if (opts.findings !== undefined) writeFileSync(findingsPath, opts.findings);
  const advisoriesPath = join(root, "advisories.md");
  writeFileSync(advisoriesPath, opts.advisories ?? "");
  const freshnessPath = join(root, "freshness.md");
  writeFileSync(freshnessPath, "#### Freshness\n\nbehind the template branch by 3 commit(s).\n");
  const calls = join(root, "calls.txt");
  const summary = join(root, "summary.md");
  writeFileSync(summary, "");
  // The stub stands in for `gh api --jq`, so the fixture is already the
  // filter's OUTPUT: the bare comment id, or nothing at all when the marker
  // matched no comment.
  const listing = join(root, "comments.json");
  writeFileSync(listing, opts.existing === undefined ? "" : `${opts.existing}\n`);
  const proc = Bun.spawnSync(["bash", script], {
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
      INTEGRITY: opts.integrity ?? "success",
      PR_NUMBER: "12",
      RUN_URL: "https://example.invalid/run/1",
      MARKER,
      CALLS: calls,
      GH_COMMENTS_ID: listing,
      ...opts.env,
    },
  });
  const read = (p: string): string => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    calls: read(calls),
    summary: read(summary),
  };
}

describe("the template's validate-template job", () => {
  test("every golden renders it identically, and it IS in all-green's needs", () => {
    for (const golden of GOLDENS) {
      const jobs = ci(golden).jobs;
      expect(jobs["validate-template"]).toBeDefined();
      // Integrity is a real gate again, so the job belongs in the gate.
      expect(jobs["all-green"]?.needs ?? []).toContain("validate-template");
      expect(reportStep(golden).run).toBe(reportStep("minimal").run);
      expect(freshnessStep(golden).run).toBe(freshnessStep("minimal").run);
    }
  });

  test("the verdict is deferred, not discarded: a last step re-raises it", () => {
    const job = ci("minimal").jobs["validate-template"];
    const action = job?.steps?.[1];
    expect(action?.["continue-on-error"]).toBe(true);
    expect(action?.with?.["findings-file"]).toContain("validate-findings.md");
    // The failing step is LAST, so the comment is already posted when the
    // gate goes red.
    const last = job?.steps?.[4];
    expect(last?.if).toBe("steps.integrity.outcome == 'failure'");
    expect(last?.run).toContain("exit 1");
    expect(job?.permissions).toEqual({ "contents": "read", "pull-requests": "write" });
  });

  test("freshness can never fail the job", () => {
    expect(freshnessStep("minimal")["continue-on-error"]).toBe(true);
    // No copier and no render: it is a ref compare and nothing more.
    const run = freshnessStep("minimal").run ?? "";
    expect(run).not.toMatch(/^\s*copier\s/m);
    expect(run).toContain("branches/template");
    for (const call of run.matchAll(/^\s*\S*\bgh\s+api\b/gm)) expect(call[0]).toContain("timeout");
  });

  test("every reporting call carries a deadline", () => {
    for (const call of (reportStep("minimal").run ?? "").matchAll(/^\s*\S*\bgh\s+api\b/gm)) {
      expect(call[0]).toContain("timeout");
    }
  });

  test("an integrity failure posts the findings and says it blocks", () => {
    const r = run({ findings: "#### Errors (1)\n\n- ci.yml drifted\n", integrity: "failure" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("POST");
    expect(r.summary).toContain("ci.yml drifted");
    expect(r.summary).toContain("This FAILS the check.");
  });

  test("a clean tree that is BEHIND comments about freshness without blocking", () => {
    const r = run({ findings: "", freshness: "behind" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("POST");
    expect(r.summary).toContain("Passed");
    expect(r.summary).toContain("behind the template branch");
    expect(r.summary).not.toContain("This FAILS the check.");
  });

  // Advisories are the action's non-failing stream. Folding them into the
  // integrity verdict had a clean repository reading as blocked.
  test("advisories are reported without ever claiming to block", () => {
    const r = run({ findings: "", advisories: "#### Advisories (1)\n\n- consider a codeql job\n" });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain("consider a codeql job");
    expect(r.summary).toContain("Passed");
    expect(r.summary).not.toContain("This FAILS the check.");
    // Worth a comment, since there is something to say.
    expect(r.calls).toContain("POST");
  });

  test("clean and fresh: no new comment at all", () => {
    const r = run({ findings: "", freshness: "fresh" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).not.toContain("POST");
    expect(r.calls).not.toContain("PATCH");
    expect(r.summary).toContain("Up to date with the template branch.");
  });

  test("clean and fresh still clears a comment a previous run left behind", () => {
    const r = run({ findings: "", freshness: "fresh", existing: "555" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("PATCH");
    expect(r.calls).toContain("555");
  });

  test("an existing comment is updated, never duplicated", () => {
    const r = run({
      findings: "#### Errors (1)\n\n- drift\n",
      integrity: "failure",
      existing: "77",
    });
    expect(r.calls).toContain("PATCH");
    expect(r.calls).not.toContain("POST");
  });

  test("a skipped freshness check says so instead of claiming up to date", () => {
    const r = run({ findings: "", freshness: "skipped" });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain("Not checked this run");
    expect(r.summary).not.toContain("Up to date");
  });

  test("a push writes the summary and never touches the comments API", () => {
    const r = run({ findings: "", freshness: "behind", event: "push" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toBe("");
    expect(r.summary).toContain("behind the template branch");
  });

  test("a missing findings file reports that the validator never ran", () => {
    const r = run({ integrity: "failure" });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain("exited before reporting");
    expect(r.summary).not.toContain("Passed");
  });

  test("a comments API failure degrades to a warning, never failing the step", () => {
    const r = run({
      findings: "#### Errors (1)\n\n- drift\n",
      integrity: "failure",
      env: { GH_FAIL: "1" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::");
    expect(r.summary).toContain("drift");
  });

  test("the comment carries the stable marker so the next run finds it", () => {
    const r = run({ findings: "", freshness: "behind" });
    expect(r.summary).toContain(MARKER);
  });
});
