// Unit tests for the one-shot copilot-review gate: the rules-first order
// of operations (a copilot_code_review base rule expects the review and
// forbids the non-blocking pass), the involvement probe on rule-less
// repos (requested reviewer / existing check run / posted review, with
// an older-sha review as involvement-not-arrival), arrival via a
// completed check run (any conclusion) or a head-sha review, and the
// fail-closed handling of API failures. gh is a PATH stub serving the
// four endpoints from files; nothing here touches the network or sleeps.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "gate.ts");

const HEAD_SHA = "b".repeat(40);
const OLD_SHA = "c".repeat(40);
const COPILOT_RULE = [{ type: "copilot_code_review" }];
const COMPLETED_CHECK = {
  check_runs: [{ status: "completed", pull_requests: [{ number: 12 }] }],
};
const AWAITING = "::error::waiting for Copilot review at";
// The actionable recovery tail of the fail-fast message: the gate exists
// to be re-armable, so the diagnostic MUST tell the operator the job
// re-runs itself and how to re-run it by hand if it does not. Pinned so a
// reword cannot quietly strip the recovery instructions and leave a bare
// "waiting" error no one can act on.
const RECOVERY =
  "This job re-runs itself when the review posts; if it does not, open this CI run and pick Re-run jobs, then Re-run failed jobs.";

// Dispatches on the requested path: branch rules, check-runs, the
// reviews listing, or the PR itself. GH_FAIL fails every call (the
// transient-outage case).
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
path="\${@: -1}"
case "$path" in
  */rules/branches/*) cat "$GH_RULES_FILE" ;;
  *check-runs*) cat "$GH_CHECKS_FILE" ;;
  */reviews*) cat "$GH_REVIEWS_FILE" ;;
  */pulls/*) cat "$GH_PR_FILE" ;;
  *) echo "gh stub: unexpected path $path" >&2; exit 1 ;;
esac
`;

interface Options {
  env?: Record<string, string>;
  rules?: unknown;
  checks?: unknown;
  /** Raw check-runs response text, written VERBATIM (no JSON.stringify) -
   * what the not-JSON leak test needs to smuggle a body fragment in. */
  checksText?: string;
  /** The PR's reviews, ONE page (wrapped into the --slurp page-array
   * shape at write time); reviewPages overrides with explicit pages. */
  reviews?: unknown;
  reviewPages?: unknown;
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
  const rawFile = (name: string, text: string): string => {
    const path = join(root, name);
    writeFileSync(path, text);
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
      GH_CHECKS_FILE:
        opts.checksText !== undefined
          ? rawFile("checks.json", opts.checksText)
          : file("checks.json", opts.checks ?? { check_runs: [] }),
      GH_REVIEWS_FILE: file("reviews.json", opts.reviewPages ?? [opts.reviews ?? []]),
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
    expect(r.output).toContain(RECOVERY);
    expect(r.output).not.toContain("copilot is not a reviewer");
  });

  test("rule present, completed check run: passes, whatever it concluded", () => {
    const r = run({ rules: COPILOT_RULE, checks: COMPLETED_CHECK });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("arrived");
    expect(r.output).toContain(HEAD_SHA);
  });

  test("a sibling PR's completed check run at the same sha is NOT this PR's arrival", () => {
    // Check runs are commit-scoped: stacked PRs share head shas, so a run
    // associated with another PR must not satisfy this PR's gate.
    const r = run({
      rules: COPILOT_RULE,
      checks: { check_runs: [{ status: "completed", pull_requests: [{ number: 99 }] }] },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("waiting for Copilot review at");
    expect(r.output).toContain(RECOVERY);
  });

  test("a completed check run with NO associations is arrival (fork PR: GitHub omits the links)", () => {
    // GitHub does not populate pull_requests on a run whose PR is from a
    // fork, so an empty array means "cannot scope", not "some other PR" -
    // accepting it is what keeps a fork PR's gate from hanging red forever.
    // A same-repo sibling always carries a non-empty array, so this does
    // not reopen the stacked-sibling hole above.
    const r = run({
      rules: COPILOT_RULE,
      checks: { check_runs: [{ status: "completed", pull_requests: [] }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("arrived");
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

  // The template twin regressed on exactly this case (it tested the plain
  // login only), so both suites now pin both spellings on both probes.
  test("no rule, the [bot] spelling in the requested reviewers is involvement too", () => {
    const r = run({
      pr: { requested_reviewers: [{ login: "copilot-pull-request-reviewer[bot]" }] },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(AWAITING);
    expect(r.output).not.toContain("copilot is not a reviewer");
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

  test("a head-sha review on a LATER page still counts (reviews are paginated oldest-first)", () => {
    // >100 reviews push the fresh head's review past page one; a single
    // unpaginated page would show only stale reviews and fail the gate
    // red forever.
    const r = run({
      reviewPages: [
        [{ commit_id: OLD_SHA, user: { login: "copilot-pull-request-reviewer[bot]" } }],
        [{ commit_id: HEAD_SHA, user: { login: "copilot-pull-request-reviewer[bot]" } }],
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("arrived");
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

  // The value-free diagnostic discipline (shared/json.ts): externally
  // controlled response bodies must never reach the workflow annotation,
  // which lands in PUBLIC CI logs.
  test("a non-JSON response body never echoes into the annotation", () => {
    const r = run({ rules: COPILOT_RULE, checksText: "LEAKED-BODY-FRAGMENT {not json" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("not valid JSON");
    expect(r.output).not.toContain("LEAKED-BODY-FRAGMENT");
  });

  test("a schema-rejected response names paths and issue codes, never received values", () => {
    const r = run({ rules: COPILOT_RULE, checks: { check_runs: "LEAKED-VALUE" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("unexpected shape");
    expect(r.output).not.toContain("LEAKED-VALUE");
  });

  // Parity with the template twin, which had to grow jq shape guards for
  // exactly these bodies: gh exits 0 on some error payloads, and a probe
  // that reads `{}` as "nothing here" passes the gate as uninvolved on a
  // response it never really read. Zod is what stops it here.
  for (const [label, shape, message] of [
    ["rules", { rules: {} }, "branch rules response"],
    ["check-runs", { checks: {} }, "check-runs response"],
    ["reviews", { reviews: {} }, "reviews response"],
    ["pull", { pr: {} }, "pull response"],
  ] as const) {
    test(`a wrong-shaped ${label} body fails immediately, never as uninvolved`, () => {
      const r = run(shape);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain(`::error::copilot_review_gate: ${message}`);
      expect(r.output).not.toContain("copilot is not a reviewer");
    });
  }

  test("a fractional PROBE_TIMEOUT_MS is rejected (Bun throws on a non-integer timeout)", () => {
    const r = run({
      rules: COPILOT_RULE,
      checks: COMPLETED_CHECK,
      env: { PROBE_TIMEOUT_MS: "1.5" },
    });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("PROBE_TIMEOUT_MS must be a whole number of milliseconds");
  });

  // Migrated from the smoke harness, which used to grep the rendered bash
  // for a bare `gh api` and for `sleep`. The deadline half is a type now
  // (runtime.ts makes timeoutMs required, so no call site can omit it);
  // this is the half a type cannot state. The gate exists to spend NO
  // runner time: it waits by failing and letting the re-armer pick it up,
  // because a private repo bills every started job a rounded-up minute.
  test("the gate never sleeps - waiting is the re-armer's job", () => {
    for (const file of ["gate.ts", "identity.ts", "runtime.ts"]) {
      expect(readFileSync(join(import.meta.dir, file), "utf8")).not.toMatch(/\bsleep\b/);
    }
  });
});
