// release_leg_move.ts: the release job's home-move note. The pure
// predicate is tested directly; the script-level tests build a real git
// repo whose HEAD is the pre-update default branch (ci.yml still carrying
// info-release) and whose working tree carries the delivered render (the
// all-green.yml release leg) - exactly the shape the sync leg hands the
// detection - and assert the report in both directions.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CI_WORKFLOW_PATH,
  releaseLegMoveNote,
  WRAPPER_WORKFLOW_PATH,
} from "../../.github/scripts/sync/release_leg_move.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/release_leg_move.ts");

const OLD_CI = "name: CI\njobs:\n  checks:\n  ci:\n  info-release:\n    secrets: inherit\n";
const NEW_CI = "name: CI\njobs:\n  checks:\n  ci:\n";
const OLD_WRAPPER = "name: All Green\njobs:\n  verdict:\n";
const NEW_WRAPPER = "name: All Green\njobs:\n  verdict:\n  release:\n    needs: [verdict]\n";

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
 * then overwritten with `delivered` (the post-sync state). */
function makeTarget(headFiles: Record<string, string>, delivered: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "release-leg-move-"));
  const root = join(base, "target");
  mkdirSync(root);
  for (const [rel, content] of Object.entries(headFiles)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  initGitRepo(root);
  for (const [rel, content] of Object.entries(delivered)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function runScript(
  root: string,
  extraArgs: string[] = [],
): { exitCode: number; stdout: string; report: string } {
  const reportPath = join(root, "..", "release-leg-move.md");
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

describe("releaseLegMoveNote", () => {
  test("the note exists exactly when the update moves the release job", () => {
    expect(releaseLegMoveNote(true, false, true)).toContain("RELEASE HOME MOVE");
    expect(releaseLegMoveNote(true, false, true)).toContain("first push to");
    expect(releaseLegMoveNote(true, false, false)).toBe("");
    expect(releaseLegMoveNote(true, true, true)).toBe("");
    expect(releaseLegMoveNote(false, false, true)).toBe("");
    expect(releaseLegMoveNote(false, false, false)).toBe("");
  });
});

describe("release_leg_move script", () => {
  test("an update moving the release job writes the note", () => {
    const root = makeTarget(
      { [CI_WORKFLOW_PATH]: OLD_CI, [WRAPPER_WORKFLOW_PATH]: OLD_WRAPPER },
      { [CI_WORKFLOW_PATH]: NEW_CI, [WRAPPER_WORKFLOW_PATH]: NEW_WRAPPER },
    );
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toContain("RELEASE HOME MOVE");
    expect(r.stdout).toContain("go-live note");
  });

  test("a HEAD already past the move gets no note - the detection self-retires", () => {
    const root = makeTarget(
      { [CI_WORKFLOW_PATH]: NEW_CI, [WRAPPER_WORKFLOW_PATH]: NEW_WRAPPER },
      { [CI_WORKFLOW_PATH]: NEW_CI, [WRAPPER_WORKFLOW_PATH]: NEW_WRAPPER },
    );
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toBe("");
    expect(r.stdout).toContain("not applicable");
  });

  test("an update delivering no release leg gets no note (release-please not selected)", () => {
    const root = makeTarget(
      { [CI_WORKFLOW_PATH]: OLD_CI, [WRAPPER_WORKFLOW_PATH]: OLD_WRAPPER },
      { [CI_WORKFLOW_PATH]: NEW_CI, [WRAPPER_WORKFLOW_PATH]: OLD_WRAPPER },
    );
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toBe("");
  });

  test("a delivered ci.yml still carrying info-release gets no note - the claim would be false", () => {
    const root = makeTarget(
      { [CI_WORKFLOW_PATH]: OLD_CI, [WRAPPER_WORKFLOW_PATH]: OLD_WRAPPER },
      { [CI_WORKFLOW_PATH]: OLD_CI, [WRAPPER_WORKFLOW_PATH]: NEW_WRAPPER },
    );
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toBe("");
  });

  test("a hidden target's log line stays value-free; the note still lands", () => {
    const root = makeTarget(
      { [CI_WORKFLOW_PATH]: OLD_CI },
      { [CI_WORKFLOW_PATH]: NEW_CI, [WRAPPER_WORKFLOW_PATH]: NEW_WRAPPER },
    );
    const r = runScript(root, ["--hide-details", "true"]);
    expect(r.exitCode).toBe(0);
    expect(r.report).toContain("RELEASE HOME MOVE");
    expect(r.stdout).toContain("private repository");
    expect(r.stdout).not.toContain("info-release-to-wrapper");
  });

  test("a broken repository fails loudly instead of reading as 'absent at HEAD'", () => {
    const base = mkdtempSync(join(tmpdir(), "release-leg-move-"));
    const root = join(base, "not-a-repo");
    mkdirSync(join(root, dirname(CI_WORKFLOW_PATH)), { recursive: true });
    writeFileSync(join(root, CI_WORKFLOW_PATH), OLD_CI);
    const r = runScript(root);
    expect(r.exitCode).not.toBe(0);
    expect(r.report).toBe("");
  });
});
