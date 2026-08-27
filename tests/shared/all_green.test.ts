// Unit tests for the green-commit predicate both enforcement points share
// (build-branches/publish.ts and sync/resolve_refs.ts). The gh call is
// injected; nothing here touches the network. Fail-closed throughout: only
// a completed, successful run of the CI workflow returns null.

import { describe, expect, test } from "bun:test";
import { allGreenFailure } from "../../.github/scripts/shared/all_green.ts";
import type { RunResult } from "../../.github/scripts/shared/proc.ts";

const SHA = "a".repeat(40);

function ghReturning(
  runs: { event?: string; status?: string; conclusion?: string | null }[],
): (command: string[]) => RunResult {
  return () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      workflow_runs: runs.map((run) => ({
        event: run.event ?? "push",
        status: run.status ?? "completed",
        conclusion: run.conclusion === undefined ? "success" : run.conclusion,
      })),
    }),
    stderr: "",
  });
}

describe("allGreenFailure", () => {
  test("queries the CI workflow's runs at the commit - the workflow path in the URL binds the verdict to the real gate", () => {
    const calls: string[][] = [];
    const gh = (command: string[]): RunResult => {
      calls.push(command);
      return ghReturning([{}])(command);
    };
    expect(allGreenFailure("Vivswan/repo-platform", SHA, gh)).toBeNull();
    expect(calls).toEqual([
      [
        "gh",
        "api",
        `repos/Vivswan/repo-platform/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=100`,
      ],
    ]);
  });

  test("a completed successful run is green", () => {
    expect(allGreenFailure("o/r", SHA, ghReturning([{}]))).toBeNull();
  });

  test("any success among several runs is green (a re-run or later dispatch ran the same tree)", () => {
    const gh = ghReturning([{ conclusion: "failure" }, { conclusion: "success" }]);
    expect(allGreenFailure("o/r", SHA, gh)).toBeNull();
  });

  test("a failed conclusion names itself", () => {
    const reason = allGreenFailure("o/r", SHA, ghReturning([{ conclusion: "failure" }]));
    expect(reason).toContain("concluded 'failure'");
  });

  test("an in-progress run is not green yet", () => {
    const gh = ghReturning([{ status: "in_progress", conclusion: null }]);
    expect(allGreenFailure("o/r", SHA, gh)).toContain("still 'in_progress'");
  });

  test("no CI runs at all reads as CI never having vouched", () => {
    expect(allGreenFailure("o/r", SHA, ghReturning([]))).toContain("no ci.yml run");
  });

  test("a successful pull_request run never vouches - it tested the synthetic merge, not the sha's own tree", () => {
    const gh = ghReturning([{ event: "pull_request", conclusion: "success" }]);
    expect(allGreenFailure("o/r", SHA, gh)).toContain("no ci.yml run of a direct event");
  });

  test("schedule and dispatch runs vouch like push runs - they check out the sha itself", () => {
    expect(allGreenFailure("o/r", SHA, ghReturning([{ event: "schedule" }]))).toBeNull();
    expect(allGreenFailure("o/r", SHA, ghReturning([{ event: "workflow_dispatch" }]))).toBeNull();
  });

  test("an API failure fails closed with the error's tail, not a pass", () => {
    const gh = (): RunResult => ({ exitCode: 1, stdout: "", stderr: "gh: HTTP 502\n" });
    const reason = allGreenFailure("o/r", SHA, gh);
    expect(reason).toContain("gh: HTTP 502");
    expect(reason).toContain("fails closed");
  });

  test("a silent API failure still reports the exit code", () => {
    const gh = (): RunResult => ({ exitCode: 4, stdout: "", stderr: "" });
    expect(allGreenFailure("o/r", SHA, gh)).toContain("exit 4");
  });
});
