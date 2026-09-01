// gate_rework.ts: the meta-check gate rework's transition note. The pure
// predicate is tested directly; the script-level tests build a real git
// repo whose HEAD is the pre-update default branch (still carrying the
// verdict wrapper) and whose working tree carries the delivered render
// (the wrapper deleted, ci.yml carrying the all-green gate job) - exactly
// the shape the sync leg hands the detection - and assert the report in
// both directions.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CI_WORKFLOW_PATH,
  gateReworkNote,
  WRAPPER_WORKFLOW_PATH,
} from "../../.github/scripts/sync/gate_rework.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/gate_rework.ts");

const OLD_CI = "name: CI\njobs:\n  checks:\n  ci:\n";
const NEW_CI = "name: CI\njobs:\n  checks:\n  ci:\n  all-green:\n    needs: [checks, ci]\n";
const OLD_WRAPPER = "name: All Green\njobs:\n  verdict:\n";

function gitFreeEnv(): Record<string, string> {
  // Hook-driven runs (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE, which
  // would redirect every git subprocess these tests spawn away from their
  // scratch repositories.
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function initGitRepo(dir: string): void {
  const run = (...args: string[]) => {
    const proc = boundedSpawnSync(["git", "-C", dir, ...args], { env: gitFreeEnv() });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
    }
  };
  run("init", "-b", "main");
  run("config", "user.name", "test");
  run("config", "user.email", "test@example.com");
  run("add", "-A");
  run("commit", "-qm", "pre-sync state");
}

/** A target repo whose HEAD holds `headFiles` and whose working tree was
 * then overwritten with `delivered` (the post-sync state; a null value
 * DELETES the path - the rework's whole point). */
function makeTarget(
  headFiles: Record<string, string>,
  delivered: Record<string, string | null>,
): string {
  const base = mkdtempSync(join(tmpdir(), "gate-rework-"));
  const root = join(base, "target");
  mkdirSync(root);
  for (const [rel, content] of Object.entries(headFiles)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  initGitRepo(root);
  for (const [rel, content] of Object.entries(delivered)) {
    if (content === null) {
      rmSync(join(root, rel), { force: true });
      continue;
    }
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function runScript(
  root: string,
  extraArgs: string[] = [],
): { exitCode: number; stdout: string; report: string } {
  const reportPath = join(root, "..", "gate-rework.md");
  const proc = boundedSpawnSync(
    ["bun", script, "--root", root, "--report", reportPath, ...extraArgs],
    { env: gitFreeEnv() },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    report: existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "",
  };
}

describe("gateReworkNote", () => {
  test("the note exists exactly when the update deletes the wrapper and ships the gate", () => {
    expect(gateReworkNote(true, false, true)).toContain("GATE REWORK");
    expect(gateReworkNote(true, false, true)).toContain("no bootstrap path");
    // A delivery still carrying the wrapper, a ci.yml without the gate
    // job, or a HEAD that never had the wrapper: no claim to make.
    expect(gateReworkNote(true, true, true)).toBe("");
    expect(gateReworkNote(true, false, false)).toBe("");
    expect(gateReworkNote(false, false, true)).toBe("");
    expect(gateReworkNote(false, false, false)).toBe("");
  });
});

describe("gate_rework script", () => {
  test("an update deleting the wrapper and shipping the gate writes the note", () => {
    const root = makeTarget(
      { [CI_WORKFLOW_PATH]: OLD_CI, [WRAPPER_WORKFLOW_PATH]: OLD_WRAPPER },
      { [CI_WORKFLOW_PATH]: NEW_CI, [WRAPPER_WORKFLOW_PATH]: null },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("GATE REWORK");
    expect(result.stdout).toContain("the PR body carries the note");
  });

  test("a target already past the rework writes an empty report", () => {
    const root = makeTarget({ [CI_WORKFLOW_PATH]: NEW_CI }, { [CI_WORKFLOW_PATH]: NEW_CI });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
    expect(result.stdout).toContain("not applicable");
  });

  test("a delivery that keeps the wrapper (a partial render) makes no claim", () => {
    const root = makeTarget(
      { [CI_WORKFLOW_PATH]: OLD_CI, [WRAPPER_WORKFLOW_PATH]: OLD_WRAPPER },
      { [CI_WORKFLOW_PATH]: NEW_CI },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("a delivered ci.yml without the gate job makes no claim either", () => {
    const root = makeTarget(
      { [CI_WORKFLOW_PATH]: OLD_CI, [WRAPPER_WORKFLOW_PATH]: OLD_WRAPPER },
      { [CI_WORKFLOW_PATH]: OLD_CI, [WRAPPER_WORKFLOW_PATH]: null },
    );
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("--hide-details keeps the detail off the log while the note still lands", () => {
    const root = makeTarget(
      { [CI_WORKFLOW_PATH]: OLD_CI, [WRAPPER_WORKFLOW_PATH]: OLD_WRAPPER },
      { [CI_WORKFLOW_PATH]: NEW_CI, [WRAPPER_WORKFLOW_PATH]: null },
    );
    const result = runScript(root, ["--hide-details", "true"]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("GATE REWORK");
    expect(result.stdout).toContain("private repository");
    expect(result.stdout).not.toContain("deletes the all-green.yml verdict wrapper");
  });

  test("a broken repository fails loudly instead of reading damage as absent-at-HEAD", () => {
    // headEntry's fail-closed contract, re-pinned here after the retired
    // note suites carried it: a root that is no git repository at all
    // must throw, never write an empty (note-suppressing) report.
    const base = mkdtempSync(join(tmpdir(), "gate-rework-broken-"));
    const root = join(base, "target");
    mkdirSync(join(root, dirname(CI_WORKFLOW_PATH)), { recursive: true });
    writeFileSync(join(root, CI_WORKFLOW_PATH), NEW_CI);
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.report).toBe("");
  });
});
