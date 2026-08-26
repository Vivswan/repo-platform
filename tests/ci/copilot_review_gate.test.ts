// Unit tests for the one-shot copilot-review gate: the rules-first order
// of operations (a copilot_code_review base rule expects the review and
// forbids the non-blocking pass), the involvement probe on rule-less
// repos (requested reviewer / existing check run / posted review, with
// an older-sha review as involvement-not-arrival), arrival via a
// completed check run (any conclusion) or a head-sha review, and the
// fail-closed handling of API failures. gh is a PATH stub serving the
// four endpoints from files; nothing here touches the network or sleeps.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/ci/copilot_review_gate.ts");

const HEAD_SHA = "b".repeat(40);
const OLD_SHA = "c".repeat(40);
const COPILOT_RULE = [{ type: "copilot_code_review" }];
const COMPLETED_CHECK = { check_runs: [{ status: "completed" }] };
const AWAITING = "::error::waiting for Copilot review; this job is re-run automatically";

// Dispatches on the requested path: branch rules, check-runs, the
// reviews listing, or the PR itself. GH_FAIL fails every call (the
// transient-outage case).
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
case "$2" in
  */rules/branches/*) cat "$GH_RULES_FILE" ;;
  *check-runs*) cat "$GH_CHECKS_FILE" ;;
  */reviews*) cat "$GH_REVIEWS_FILE" ;;
  */pulls/*) cat "$GH_PR_FILE" ;;
  *) echo "gh stub: unexpected path $2" >&2; exit 1 ;;
esac
`;

interface Options {
  env?: Record<string, string>;
  rules?: unknown;
  checks?: unknown;
  reviews?: unknown;
  pr?: unknown;
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-gate-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const file = (name: string, value: unknown): string => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      HEAD_SHA,
      PR_NUMBER: "12",
      BASE_BRANCH: "main",
      GH_RULES_FILE: file("rules.json", opts.rules ?? []),
      GH_CHECKS_FILE: file("checks.json", opts.checks ?? { check_runs: [] }),
      GH_REVIEWS_FILE: file("reviews.json", opts.reviews ?? []),
      GH_PR_FILE: file("pr.json", opts.pr ?? { requested_reviewers: [] }),
      ...opts.env,
    },
  });
  return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

describe("copilot_review_gate.ts", () => {
  test("rule present, review missing: fails fast with the re-run message, never the non-blocking pass", () => {
    const r = run({ rules: COPILOT_RULE });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("the review is expected by configuration");
    expect(r.output).toContain(AWAITING);
    expect(r.output).not.toContain("copilot is not a reviewer");
  });

  test("rule present, completed check run: passes, whatever it concluded", () => {
    const r = run({ rules: COPILOT_RULE, checks: COMPLETED_CHECK });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("arrived");
    expect(r.output).toContain(HEAD_SHA);
  });

  test("rule present, review posted for the head sha: passes without any check run", () => {
    const r = run({
      rules: COPILOT_RULE,
      reviews: [{ commit_id: HEAD_SHA, user: { login: "copilot-pull-request-reviewer[bot]" } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("arrived");
  });

  test("no rule, no involvement: passes non-blocking with the log line", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("copilot is not a reviewer on this PR");
  });

  test("no rule, Copilot in the requested reviewers: fails fast for the re-runner", () => {
    const r = run({ pr: { requested_reviewers: [{ login: "Copilot" }] } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(AWAITING);
  });

  test("no rule, an in-progress check run is involvement, not arrival", () => {
    const r = run({ checks: { check_runs: [{ status: "in_progress" }] } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(AWAITING);
  });

  test("no rule, a Copilot review for an OLDER sha is involvement - the re-review is awaited", () => {
    const r = run({
      reviews: [{ commit_id: OLD_SHA, user: { login: "copilot-pull-request-reviewer[bot]" } }],
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(AWAITING);
  });

  test("no rule, a review posted for the head sha passes as arrival", () => {
    const r = run({
      reviews: [{ commit_id: HEAD_SHA, user: { login: "copilot-pull-request-reviewer[bot]" } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("arrived");
  });

  test("a human requested reviewer is not Copilot involvement", () => {
    const r = run({ pr: { requested_reviewers: [{ login: "some-human" }] } });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("copilot is not a reviewer on this PR");
  });

  test("a review by a null user (deleted account) is not Copilot involvement", () => {
    // The reviews schema allows user: null (GitHub serves it for deleted
    // accounts); the filter must skip it instead of crashing or counting
    // it as involvement.
    const r = run({ reviews: [{ commit_id: HEAD_SHA, user: null }] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("copilot is not a reviewer on this PR");
  });

  test("API failures never pass as uninvolved: the gate fails closed naming the probe problem", () => {
    const r = run({ env: { GH_FAIL: "1" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::cannot rule Copilot's involvement");
  });

  test("a response gh accepted but the schema rejects fails immediately", () => {
    const r = run({ checks: { check_runs: [{ status: 7 }] } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::copilot_review_gate: check-runs response");
  });
});
