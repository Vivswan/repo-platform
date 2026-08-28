// label_preflight.ts: the fail-closed gate in front of the settings
// apply's label reconciliation. The script is gh-bound (live labels, and
// the fetch-mode reference files), so a stub gh on PATH serves canned
// answers; the assertions read the exit code and the ::error:: naming the
// label and its referencing file - the message a human acts on.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedRemovals } from "../../.github/scripts/fleet/label_preflight.ts";
import { collectReferences } from "../../.github/scripts/fleet/label_references.ts";

const script = join(import.meta.dir, "../../.github/scripts/fleet/label_preflight.ts");

// Serves: the live-label listing (LIVE_LABELS, one name per line; the
// LABELS_FAIL modes force a permission 403, a rate-limit 403, a 404, or a
// 500), the contents listings for the two reference directories (fetch
// mode), and each raw file fetch (CLOSE_YML_MISSING turns the fetch of a
// LISTED file into a 404 - the listed-but-unreadable damage shape).
// Unknown calls fail loudly - a preflight probing an endpoint this stub
// does not model is a test bug.
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  *"--paginate repos/"*"/labels"*)
    if [ "\${LABELS_FAIL:-}" = "true" ]; then
      echo "gh: The token cannot read labels (HTTP 403)" >&2
      exit 1
    fi
    if [ "\${LABELS_FAIL_RATELIMIT:-}" = "true" ]; then
      echo "gh: API rate limit exceeded for installation (HTTP 403)" >&2
      exit 1
    fi
    if [ "\${LABELS_FAIL_404:-}" = "true" ]; then
      # "rate limit" text ON PURPOSE: the round-4 precedence bug applied
      # the rate-limit exclusion to 404s too, and this message is the
      # mutation that catches it coming back.
      echo "gh: Not Found - see the rate limit docs (HTTP 404)" >&2
      exit 1
    fi
    if [ "\${LABELS_FAIL_500:-}" = "true" ]; then
      echo "gh: something went wrong (HTTP 500)" >&2
      exit 1
    fi
    printf '%b' "\${LIVE_LABELS:-}"
    ;;
  *"contents/.github/ISSUE_TEMPLATE?ref="*)
    if [ -n "\${FORMS_LISTING:-}" ]; then printf '%s' "$FORMS_LISTING"; else
      echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    ;;
  *"contents/.github/workflows?ref="*)
    if [ "\${WORKFLOWS_LISTING_FAIL:-}" = "true" ]; then
      echo "gh: something went wrong (HTTP 500)" >&2; exit 1; fi
    if [ -n "\${WORKFLOWS_LISTING:-}" ]; then printf '%s' "$WORKFLOWS_LISTING"; else
      echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    ;;
  *"contents/.github/workflows/close.yml?ref="*)
    if [ "\${CLOSE_YML_MISSING:-}" = "true" ]; then
      echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    printf '%b' "\${CLOSE_YML:-}"
    ;;
  *)
    echo "gh stub: unmodeled call: $args" >&2
    exit 64
    ;;
esac
`;

interface Options {
  merged: string;
  args: string[];
  env?: Record<string, string>;
  /** Files under the --target-dir fixture root. */
  targetFiles?: Record<string, string>;
}

function run(opts: Options) {
  const root = mkdtempSync(join(tmpdir(), "label-preflight-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const mergedPath = join(root, "merged-settings.yml");
  writeFileSync(mergedPath, opts.merged);
  const targetDir = join(root, "target");
  mkdirSync(targetDir);
  for (const [rel, content] of Object.entries(opts.targetFiles ?? {})) {
    mkdirSync(join(targetDir, rel, ".."), { recursive: true });
    writeFileSync(join(targetDir, rel), content);
  }
  const args = opts.args.map((arg) => (arg === "TARGET_DIR" ? targetDir : arg));
  const outputs = join(root, "gh-output.txt");
  const proc = Bun.spawnSync(["bun", script, "--merged", mergedPath, "--repo", "o/r", ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputs,
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    outputs: existsSync(outputs) ? readFileSync(outputs, "utf-8") : "",
  };
}

const SHA = "a".repeat(40);
const MERGED_WITH_BUG = "labels:\n  - name: bug\n    color: d73a4a\n";
// The gate's incident reproduction: the merged document RENAMES
// awaiting-reply to needs-response via new_name.
const MERGED_WITH_RENAME =
  "labels:\n  - name: awaiting-reply\n    new_name: needs-response\n    color: aabbcc\n";

describe("blockedRemovals", () => {
  test("blocks exactly the referenced labels that are live and not kept post-apply", () => {
    const references = collectReferences([
      { path: "f.yml", kind: "issue-form", text: 'labels: ["Answered", "bug", "ghost"]\n' },
    ]);
    const blocked = blockedRemovals(references, ["answered", "bug", "stray"], ["BUG"]);
    // "bug" is kept (case-folded), "ghost" is not live (already broken,
    // the sync's warning owns it), "stray" is removable but unreferenced.
    expect(blocked.map((r) => r.label)).toEqual(["Answered"]);
  });
});

describe("label_preflight script", () => {
  test("a referenced live label missing from the roster fails, naming label and file", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LIVE_LABELS: "answered\nbug\n" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('would REMOVE label "answered"');
    expect(r.output).toContain(".github/ISSUE_TEMPLATE/bug.yml");
  });

  test("a new_name rename of a referenced label blocks: the source name is removed post-apply", () => {
    // The fail-open the gate reproduced: rosterNames-by-source-name read
    // the renamed label as declared and stood the guard down while the
    // apply renamed it out from under the issue form.
    const r = run({
      merged: MERGED_WITH_RENAME,
      args: ["--target-dir", "TARGET_DIR"],
      targetFiles: { ".github/ISSUE_TEMPLATE/q.yml": 'labels: ["awaiting-reply"]\n' },
      env: { LIVE_LABELS: "awaiting-reply\n" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('would REMOVE label "awaiting-reply"');
    expect(r.output).toContain("renamed away via new_name");
    expect(r.output).toContain(".github/ISSUE_TEMPLATE/q.yml");
  });

  test("with BOTH rename names live, roster membership alone decides the outcome", () => {
    // Non-vacuous by construction: the live set is identical in both
    // runs, so the opposite verdicts can only come from the post-apply
    // roster - a target-passes result cannot ride on "not live" (which
    // blockedRemovals ignores regardless of the roster).
    const live = { LIVE_LABELS: "awaiting-reply\nneeds-response\n" };
    const source = run({
      merged: MERGED_WITH_RENAME,
      args: ["--target-dir", "TARGET_DIR"],
      targetFiles: { ".github/ISSUE_TEMPLATE/q.yml": 'labels: ["awaiting-reply"]\n' },
      env: live,
    });
    expect(source.exitCode).toBe(1);
    expect(source.output).toContain('would REMOVE label "awaiting-reply"');
    const target = run({
      merged: MERGED_WITH_RENAME,
      args: ["--target-dir", "TARGET_DIR"],
      targetFiles: { ".github/ISSUE_TEMPLATE/q.yml": 'labels: ["needs-response"]\n' },
      env: live,
    });
    expect(target.exitCode).toBe(0);
    expect(target.output).toContain("no referenced label is scheduled for removal");
  });

  test("a referenced label the roster declares passes", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["BUG"]\n' },
      env: { LIVE_LABELS: "bug\n" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("no referenced label is scheduled for removal");
  });

  test("an unreferenced undeclared label stays deletable (no block)", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR"],
      targetFiles: { ".github/workflows/ci.yml": "jobs: {}\n" },
      env: { LIVE_LABELS: "stray\nbug\n" },
    });
    expect(r.exitCode).toBe(0);
  });

  test("check mode reports the would-be blocks as warnings and exits 0", () => {
    // A check run deletes nothing, and hard-failing would cost the drift
    // report the run exists for - but the finding must still be loud.
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR", "--mode", "check"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LIVE_LABELS: "answered\nbug\n" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::");
    expect(r.output).toContain('would REMOVE label "answered"');
    expect(r.output).toContain("the apply would be BLOCKED");
    expect(r.outputs).toContain("not_applicable=false");
  });

  test("a 403 on the live-label listing fails CLOSED by default", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LABELS_FAIL: "true" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("cannot list the live labels");
  });

  test("under on-missing-permission warn, a 403 warns and stands down (mirroring the action)", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR", "--on-missing-permission", "warn"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LABELS_FAIL: "true" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::");
    expect(r.output).toContain("standing down");
    expect(r.outputs).toContain("not_applicable=true");
    expect(r.outputs).toContain("reason=the token cannot read the live labels");
  });

  test("a required labels section outranks warn: the action would fail that section, so the preflight fails too", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: [
        "--target-dir",
        "TARGET_DIR",
        "--on-missing-permission",
        "warn",
        "--required-sections",
        "labels",
      ],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LABELS_FAIL: "true" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("cannot list the live labels");
  });

  test("under warn, a rate-limit 403 is NOT a permission refusal and still fails CLOSED", () => {
    // The action's own permission classification excludes rate limits:
    // the quota recovers, and a stand-down here would publish a false
    // permission claim while the apply itself proceeds against the limit.
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR", "--on-missing-permission", "warn"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LABELS_FAIL_RATELIMIT: "true" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("cannot list the live labels");
  });

  test("under warn, a 404 is permission-shaped and stands down - even with rate-limit text", () => {
    // The render already resolved this repo, so a 404 on its labels means
    // the token cannot see it. The stub's 404 message contains the words
    // "rate limit" on purpose: the rate-limit exclusion belongs to 403
    // alone, and applying it to 404s (the round-4 precedence bug) must
    // fail this test.
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR", "--on-missing-permission", "warn"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LABELS_FAIL_404: "true" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("standing down");
    expect(r.outputs).toContain("not_applicable=true");
    expect(r.outputs).toContain("reason=the token cannot read the live labels");
  });

  test("under warn, a NON-permission listing failure still fails CLOSED", () => {
    // on-missing-permission tolerates exactly the permission refusal; a
    // 500 is an unreadable roster and must never read as an empty one.
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR", "--on-missing-permission", "warn"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LABELS_FAIL_500: "true" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("cannot list the live labels");
  });

  test("a merged document with no labels key is not applicable (no probes, no failure)", () => {
    const r = run({
      merged: "repository:\n  private: false\n",
      args: ["--target-dir", "TARGET_DIR"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LABELS_FAIL: "true" }, // would fail if the probe ran
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("preflight not applicable");
    // The stood-down state is a step output: for a hidden target the
    // capture swallows the log line, and the workflow's public notice
    // fires on this instead.
    expect(r.outputs).toContain("not_applicable=true");
    expect(r.outputs).toContain("reason=the merged settings document declares no labels key");
  });

  test("a checked run publishes not_applicable=false (the stood-down notice stays quiet)", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR"],
      targetFiles: { ".github/workflows/ci.yml": "jobs: {}\n" },
      env: { LIVE_LABELS: "bug\n" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toContain("not_applicable=false");
  });

  test("fetch mode reads the reference files at the pinned ref and blocks the same way", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--ref", SHA],
      env: {
        LIVE_LABELS: "answered\nbug\n",
        WORKFLOWS_LISTING: JSON.stringify([{ name: "close.yml", type: "file" }]),
        CLOSE_YML: "jobs:\n  x:\n    if: github.event.label.name == 'answered'\n",
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('would REMOVE label "answered"');
    expect(r.output).toContain(".github/workflows/close.yml");
  });

  test("fetch mode: both reference directories missing (404) is simply no references", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--ref", SHA],
      env: { LIVE_LABELS: "stray\n" },
    });
    expect(r.exitCode).toBe(0);
  });

  test("fetch mode: a listed file that fetches 404 fails CLOSED (damage, not a race)", () => {
    // The listing and the fetch pin the SAME ref, so a 404 on a listed
    // file cannot be a branch race; reading it as "no references" would
    // pass the gate open (mutation-verified by the gate: returning ""
    // here silently weakened the guard with every test still green).
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--ref", SHA],
      env: {
        LIVE_LABELS: "answered\n",
        WORKFLOWS_LISTING: JSON.stringify([{ name: "close.yml", type: "file" }]),
        CLOSE_YML_MISSING: "true",
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("listed but unreadable");
  });

  test("the reference source is exactly one of --target-dir and --ref, and --ref must be a sha", () => {
    expect(run({ merged: MERGED_WITH_BUG, args: [] }).exitCode).toBe(1);
    expect(
      run({ merged: MERGED_WITH_BUG, args: ["--target-dir", "TARGET_DIR", "--ref", SHA] }).exitCode,
    ).toBe(1);
    const short = run({ merged: MERGED_WITH_BUG, args: ["--ref", "main"] });
    expect(short.exitCode).toBe(1);
    expect(short.output).toContain("40-hex commit sha");
  });

  test("--mode and --on-missing-permission reject values the action does not define", () => {
    const mode = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR", "--mode", "dry-run"],
    });
    expect(mode.exitCode).toBe(1);
    expect(mode.output).toContain("--mode must be one of apply, check");
    const omp = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR", "--on-missing-permission", "ignore"],
    });
    expect(omp.exitCode).toBe(1);
    expect(omp.output).toContain("--on-missing-permission must be one of fail, warn");
  });

  test("a sections allowlist without labels stands the preflight down (the action reconciles none)", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR", "--sections", "repository, rulesets"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LABELS_FAIL: "true" }, // would fail if any probe ran
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("does not select labels");
    expect(r.outputs).toContain("not_applicable=true");
  });

  test("a sections allowlist naming labels keeps the gate armed", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "TARGET_DIR", "--sections", "repository,labels"],
      targetFiles: { ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["answered"]\n' },
      env: { LIVE_LABELS: "answered\n" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('would REMOVE label "answered"');
  });

  test("a nonexistent --target-dir fails CLOSED, not as an empty reference set", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--target-dir", "/nonexistent/checkout"],
      env: { LIVE_LABELS: "answered\n" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("not a directory");
  });

  test("a non-404 directory-listing failure in fetch mode fails CLOSED", () => {
    const r = run({
      merged: MERGED_WITH_BUG,
      args: ["--ref", SHA],
      env: { LIVE_LABELS: "answered\n", WORKFLOWS_LISTING_FAIL: "true" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("listing failed");
  });
});
