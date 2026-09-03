// The self-apply's two-hop scripts checkout: callers pin
// reusable-apply-settings.yml @build, whose tree carries only workflow
// files, so the resolve step reads the build tip's provenance stamp and
// lands the scripts checkout on the stamped green main commit. These
// tests run the WORKFLOW's own run block (extracted from the live file,
// so the guard cannot drift from what ships) against a stub `gh`,
// forcing every branch - the fail-closed refusal of a stampless
// non-history sha included - and prove the inline stamp grammar agrees
// with shared/commit_stamp.ts, the shape's owner, on every fixture.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { commitStampParse, commitStampWrite } from "../../.github/scripts/shared/commit_stamp.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const workflowPath = resolve(
  import.meta.dir,
  "../../.github/workflows/reusable-apply-settings.yml",
);
const BUILD_SHA = "c".repeat(40);
const SOURCE_SHA = "d".repeat(40);

function applySteps(): Record<string, unknown>[] {
  const doc = parseYaml(readFileSync(workflowPath, "utf-8")) as Record<string, unknown>;
  const jobs = doc.jobs as Record<string, { steps: Record<string, unknown>[] }>;
  return jobs.apply.steps;
}

/** The live resolve step's run block; a missing step means the two-hop
 *  was dropped, which must fail these tests, not skip them. */
function resolveRunBlock(): string {
  const step = applySteps().find((s) => s.id === "scripts");
  if (step === undefined || typeof step.run !== "string") {
    throw new Error(
      "reusable-apply-settings.yml has no `scripts` resolve step - the two-hop is gone",
    );
  }
  return step.run;
}

/** Runs the resolve block the way the runner does (bash -e -o pipefail),
 *  with a stub `gh` whose commit message and compare status come from the
 *  fixture. Every stub call is logged so the no-call path is provable. */
function run(workflowSha: string, gh: { message?: string; status?: string }) {
  const root = mkdtempSync(join(tmpdir(), "scripts-ref-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'echo "$*" >> "$GH_STUB_LOG"',
      'case "$*" in',
      // --jq '.commit.message' rides along as an ignored argument: the
      // stub answers with the fixture's raw message, which is what the
      // real jq filter would print.
      `  *commits/*) ${gh.message === undefined ? "exit 1" : 'printf "%s\\n" "$GH_STUB_MESSAGE"'} ;;`,
      `  *compare/*) ${gh.status === undefined ? "exit 1" : 'printf "%s\\n" "$GH_STUB_STATUS"'} ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const script = join(root, "resolve.sh");
  writeFileSync(script, resolveRunBlock());
  const outputPath = join(root, "output.txt");
  const logPath = join(root, "gh-calls.log");
  const proc = boundedSpawnSync(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputPath,
      GH_TOKEN: "stub",
      WORKFLOW_SHA: workflowSha,
      GH_STUB_LOG: logPath,
      GH_STUB_MESSAGE: gh.message ?? "",
      GH_STUB_STATUS: gh.status ?? "",
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    outputs: existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : "",
    ghCalls: existsSync(logPath) ? readFileSync(logPath, "utf-8") : "",
  };
}

/** A build-tip commit message the publisher would write. */
function stampedMessage(sha: string): string {
  return `build\n\n${commitStampWrite("https://github.com", "Vivswan/repo-platform", sha)}\nrun: https://github.com/Vivswan/repo-platform/actions/runs/1`;
}

describe("the resolve step's stamp hop", () => {
  test("a stamped build-tip sha resolves to the stamped source commit", () => {
    const message = stampedMessage(SOURCE_SHA);
    // Grammar parity with the stamp's owner: the workflow's sed must land
    // exactly where commitStampParse lands.
    expect(commitStampParse(message)).toBe(SOURCE_SHA);
    const result = run(BUILD_SHA, { message });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toBe(`ref=${SOURCE_SHA}\n`);
    // The stamp decided; the compare endpoint was never consulted.
    expect(result.ghCalls).not.toContain("compare");
  });

  test("a stampless main-history sha (behind or identical) is used directly", () => {
    for (const status of ["behind", "identical"]) {
      const result = run(BUILD_SHA, { message: "docs: something unstamped", status });
      expect(result.exitCode).toBe(0);
      expect(result.outputs).toBe(`ref=${BUILD_SHA}\n`);
    }
  });

  // The refusal is the DELIBERATE `*)` branch: its ::error:: names the
  // compare status it saw. A silent set -e death (the `|| echo unreachable`
  // fallback dropped, say) would also exit nonzero with no output, so the
  // refusal text is what tells the two apart.
  test.each([
    { reason: "ahead of main is not main history", status: "ahead", seen: "ahead" },
    { reason: "diverged from main is not main history", status: "diverged", seen: "diverged" },
    {
      reason: "a compare failure reads as unreachable - unprovable is unrunnable",
      status: undefined,
      seen: "unreachable",
    },
  ])("a stampless NON-history sha refuses, publishing no ref: $reason", ({ status, seen }) => {
    const result = run(BUILD_SHA, { message: "not a build commit", status });
    expect(result.exitCode).not.toBe(0);
    expect(result.outputs).toBe("");
    expect(result.stdout).toContain("refusing to run repo-platform scripts");
    expect(result.stdout).toContain(`compare status: ${seen}`);
  });

  test.each([
    {
      reason: "a 39-hex sha",
      smuggled: `source: https://github.com/Vivswan/repo-platform/commit/${"e".repeat(39)}`,
    },
    {
      reason: "a ref path where the sha belongs",
      smuggled: "source: https://github.com/Vivswan/repo-platform/commit/refs/remotes/origin/main",
    },
  ])("a malformed stamp is no stamp, per commit_stamp.ts: $reason", ({ smuggled }) => {
    expect(commitStampParse(smuggled)).toBe("");
    // With no stamp the sha falls through to the compare hop, where the
    // diverged status refuses it - the same deliberate branch as above.
    const result = run(BUILD_SHA, { message: smuggled, status: "diverged" });
    expect(result.exitCode).not.toBe(0);
    expect(result.outputs).toBe("");
    expect(result.stdout).toContain("refusing to run repo-platform scripts");
    expect(result.stdout).toContain("compare status: diverged");
  });

  test("an absent workflow sha (GHES) falls back to main without touching the API", () => {
    const result = run("", {});
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toBe("ref=main\n");
    expect(result.ghCalls).toBe("");
  });
});

describe("the two-hop stays wired", () => {
  test("the resolve step reads job.workflow_sha and queries this repository", () => {
    const step = applySteps().find((s) => s.id === "scripts");
    if (step === undefined) throw new Error("no scripts resolve step");
    expect((step.env as Record<string, unknown>).WORKFLOW_SHA).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
      "${{ job.workflow_sha }}",
    );
    // The stub matches loosely on purpose, so the real endpoint spellings
    // are pinned here instead.
    const run = resolveRunBlock();
    expect(run).toContain(
      "repos/Vivswan/repo-platform/commits/$WORKFLOW_SHA\" --jq '.commit.message'",
    );
    expect(run).toContain(
      "repos/Vivswan/repo-platform/compare/main...$WORKFLOW_SHA\" --jq '.status'",
    );
  });

  test("the platform checkout takes its ref from the resolve step", () => {
    const checkout = applySteps().find(
      (s) =>
        String(s.uses ?? "").startsWith("actions/checkout") &&
        (s.with as Record<string, unknown> | undefined)?.repository === "Vivswan/repo-platform",
    );
    if (checkout === undefined) throw new Error("no repo-platform checkout step");
    expect((checkout.with as Record<string, unknown>).ref).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
      "${{ steps.scripts.outputs.ref }}",
    );
  });
});
