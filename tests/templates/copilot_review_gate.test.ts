// Behaviour tests for the copilot-review gate the template lands in every
// fleet repository. The client-side gate is inline bash (a generated repo has
// no repo-platform scripts to call), so these tests run the REAL bytes: the
// step's `run:` block is lifted straight out of a committed golden render,
// which CI drift-checks against templates/, and executed against a stubbed
// gh. Nothing here touches the network or sleeps.
//
// The predicate mirrors .github/scripts/ci/copilot_review_gate.ts - the
// operator-side twin - so the cases below are deliberately the same cases as
// tests/ci/copilot_review_gate.test.ts: rules-first ordering, the involvement
// probe on rule-less repositories, arrival by completed check run or head-sha
// review, and fail-closed handling of API failures. A divergence between the
// two suites is the drift signal.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const RENDERS = join(import.meta.dir, "../golden-renders");
const GOLDENS = ["minimal", "all-modules", "uv-no-release-please"];

const HEAD_SHA = "b".repeat(40);
const OLD_SHA = "c".repeat(40);
const COPILOT_CHECK = "copilot-pull-request-reviewer";
const COPILOT_RULE = [{ type: "copilot_code_review" }];
const COMPLETED_CHECK = { check_runs: [{ status: "completed" }] };
const AWAITING = "::error::waiting for Copilot review at";

interface Step {
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Job {
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}

function jobs(golden: string): Record<string, Job> {
  const source = readFileSync(join(RENDERS, golden, ".github/workflows/ci.yml"), "utf8");
  return (parseYaml(source) as { jobs: Record<string, Job> }).jobs;
}

function gateStep(golden: string): Step {
  const step = jobs(golden)["copilot-review"]?.steps?.[0];
  if (step?.run === undefined) throw new Error(`${golden}: no copilot-review step to run`);
  return step;
}

// Serves the four endpoints from files, keyed on the requested path. GH_FAIL
// fails every call (the transient-outage case).
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
case "$*" in
  */rules/branches/*) cat "$GH_RULES_FILE" ;;
  *check-runs*) cat "$GH_CHECKS_FILE" ;;
  */reviews*) cat "$GH_REVIEWS_FILE" ;;
  */pulls/*) cat "$GH_PR_FILE" ;;
  *) echo "gh stub: unexpected path $2" >&2; exit 1 ;;
esac
`;

// coreutils timeout is Linux-only and the workflow only ever runs on
// ubuntu-latest, so the harness shims it to keep these tests runnable on
// macOS too. The shim still asserts every wrapped call carries a numeric
// deadline, which is the property the real binary enforces.
const timeoutStub = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ''|*[!0-9]*) echo "timeout stub: '$1' is not a deadline" >&2; exit 64 ;;
esac
shift
exec "$@"
`;

interface Options {
  env?: Record<string, string>;
  rules?: unknown;
  checks?: unknown;
  reviews?: unknown;
  reviewPages?: unknown[];
  pr?: unknown;
}

function run(opts: Options = {}, golden = "minimal") {
  const root = mkdtempSync(join(tmpdir(), "fleet-copilot-gate-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  writeFileSync(join(bin, "timeout"), timeoutStub, { mode: 0o755 });
  const script = join(root, "gate.sh");
  writeFileSync(script, gateStep(golden).run ?? "");
  const file = (name: string, value: unknown): string => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const proc = Bun.spawnSync(["bash", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/managed-repo",
      HEAD_SHA,
      PR_NUMBER: "12",
      BASE_BRANCH: "main",
      COPILOT_CHECK,
      GH_RULES_FILE: file("rules.json", opts.rules ?? []),
      GH_CHECKS_FILE: file("checks.json", opts.checks ?? { check_runs: [] }),
      // --slurp returns one array PER PAGE; a plain `reviews` fixture is
      // the single-page case.
      GH_REVIEWS_FILE: file("reviews.json", opts.reviewPages ?? [opts.reviews ?? []]),
      GH_PR_FILE: file("pr.json", opts.pr ?? { requested_reviewers: [] }),
      ...opts.env,
    },
  });
  return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

describe("the template's copilot-review gate job", () => {
  test("every golden renders the job identically, inside all-green's needs", () => {
    for (const golden of GOLDENS) {
      const all = jobs(golden);
      expect(all["copilot-review"]).toBeDefined();
      expect(all["all-green"]?.needs).toContain("copilot-review");
      // The job is base, not module- or visibility-shaped: one implementation
      // reaches the whole fleet, which is what lets the re-arm workflow target
      // a single job name.
      expect(gateStep(golden).run).toBe(gateStep("minimal").run);
    }
  });

  test("the job costs no checkout and no toolchain, and skips on non-PR events", () => {
    const job = jobs("minimal")["copilot-review"];
    // One step, no actions/checkout and no setup-*: the whole point of the
    // fail-fast design is that a waiting gate bills nothing.
    expect(job?.steps).toHaveLength(1);
    expect(gateStep("minimal").if).toBe("github.event_name == 'pull_request'");
    expect(job?.permissions).toEqual({
      "contents": "read",
      "checks": "read",
      "pull-requests": "read",
    });
  });

  test("every network call carries a hard deadline and nothing sleeps", () => {
    const script = gateStep("minimal").run ?? "";
    for (const call of script.matchAll(/^\s*\S*\bgh\s+api\b/gm)) {
      expect(call[0]).toContain("timeout");
    }
    expect(script).not.toMatch(/\bsleep\b/);
  });

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
      reviews: [{ commit_id: HEAD_SHA, user: { login: `${COPILOT_CHECK}[bot]` } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("arrived");
  });

  // There is no API that triggers a Copilot review, so the failure has to
  // name the human action or the reader is left waiting on something that
  // may never come.
  test("the waiting message names the manual request and the re-run", () => {
    const r = run({ rules: COPILOT_RULE });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Reviewers -> Copilot");
    expect(r.output).toContain("draft PR or an exhausted review quota");
    expect(r.output).toContain("Re-run failed jobs");
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

  // Regression pin: the requested-reviewer probe used to test the plain
  // login only, so a [bot]-spelled reviewer request read as "not a
  // reviewer" and the gate went silently green where the operator twin
  // fails fast. Both spellings now reach every probe through one shared jq
  // is_copilot definition.
  test("no rule, the [bot] spelling in the requested reviewers is involvement too", () => {
    const r = run({ pr: { requested_reviewers: [{ login: `${COPILOT_CHECK}[bot]` }] } });
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
    const r = run({ reviews: [{ commit_id: OLD_SHA, user: { login: `${COPILOT_CHECK}[bot]` } }] });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(AWAITING);
  });

  test("no rule, a review posted for the head sha passes as arrival", () => {
    const r = run({ reviews: [{ commit_id: HEAD_SHA, user: { login: `${COPILOT_CHECK}[bot]` } }] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("arrived");
  });

  // GitHub returns reviews oldest-first, so on a busy PR a single unpaginated
  // page shows only the stalest 100 and Copilot's latest review is invisible.
  test("a head-sha review on a LATER page still counts", () => {
    const r = run({
      reviewPages: [
        [{ commit_id: OLD_SHA, user: { login: "someone" } }],
        [{ commit_id: HEAD_SHA, user: { login: `${COPILOT_CHECK}[bot]` } }],
      ],
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
    const r = run({ reviews: [{ commit_id: HEAD_SHA, user: null }] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("copilot is not a reviewer on this PR");
  });

  test("API failures never pass as uninvolved: the gate fails closed naming the probe problem", () => {
    const r = run({ env: { GH_FAIL: "1" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::cannot rule Copilot's involvement");
  });

  test("a body gh accepted but jq cannot read fails closed, never as uninvolved", () => {
    const r = run({ env: { GH_REVIEWS_FILE: "/dev/null" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::cannot rule Copilot's involvement");
  });

  // gh exits 0 on some error payloads, and jq iterates an OBJECT's values
  // without complaint, so an unguarded probe reads `{}` as a confident
  // "nothing here" and the gate passes as uninvolved on a body it never
  // really read. Each probe asserts its shape; one wrong shape is enough to
  // fail the whole gate closed, so they are pinned one at a time.
  for (const [label, shape] of [
    ["rules", { rules: {} }],
    ["check-runs", { checks: {} }],
    ["reviews", { reviews: {} }],
    ["pull", { pr: {} }],
  ] as const) {
    test(`a wrong-shaped ${label} body fails closed, never as uninvolved`, () => {
      const r = run(shape);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("::error::cannot rule Copilot's involvement");
      expect(r.output).not.toContain("copilot is not a reviewer");
    });
  }
});
