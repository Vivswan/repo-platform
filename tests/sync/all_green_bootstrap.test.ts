// all_green_bootstrap.ts: the first-verdict-delivery note. The pure
// predicate is tested directly; the script-level tests build a real git
// repo whose HEAD is the pre-update default branch and whose working tree
// carries the delivered render - exactly the shape the sync leg hands the
// detection - and assert the report in both directions: condition true
// (the update introduces the verdict workflow) writes the note, condition
// false (the default branch already has it, or the render delivers none)
// writes an empty report.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ALL_GREEN_WORKFLOW_PATH,
  bootstrapNote,
} from "../../.github/scripts/sync/all_green_bootstrap.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/all_green_bootstrap.ts");

const WORKFLOW = "name: All Green\non: workflow_run\n";

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
    const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: gitFreeEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
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
  const base = mkdtempSync(join(tmpdir(), "all-green-bootstrap-"));
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
): { exitCode: number | null; stdout: string; stderr: string; report: string } {
  const reportPath = join(root, "..", "all-green-bootstrap.md");
  const proc = Bun.spawnSync(
    ["bun", script, "--root", root, "--report", reportPath, ...extraArgs],
    { env: gitFreeEnv(), stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    report: existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "",
  };
}

describe("bootstrapNote", () => {
  test("the note exists exactly when the update introduces the workflow", () => {
    expect(bootstrapNote(true, false)).toContain("admin bypass");
    expect(bootstrapNote(true, false)).toContain("`.github/workflows/all-green.yml`");
    expect(bootstrapNote(true, true)).toBe("");
    expect(bootstrapNote(false, false)).toBe("");
    expect(bootstrapNote(false, true)).toBe("");
  });
});

describe("all_green_bootstrap script", () => {
  test("an update introducing the verdict workflow writes the note", () => {
    const root = makeTarget({ "README.md": "hi\n" }, { [ALL_GREEN_WORKFLOW_PATH]: WORKFLOW });
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toContain("FIRST VERDICT DELIVERY");
    expect(r.report).toContain("admin bypass");
    expect(r.stdout).toContain("one-time admin-bypass merge");
  });

  test("a default branch already carrying the workflow gets no note", () => {
    const root = makeTarget(
      { [ALL_GREEN_WORKFLOW_PATH]: WORKFLOW },
      { [ALL_GREEN_WORKFLOW_PATH]: WORKFLOW },
    );
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toBe("");
    expect(r.stdout).toContain("not applicable");
  });

  test("an update that delivers no verdict workflow gets no note", () => {
    const root = makeTarget({ "README.md": "hi\n" }, { "README.md": "new\n" });
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toBe("");
  });

  test("a hidden target's log line stays value-free; the note still lands", () => {
    const root = makeTarget({ "README.md": "hi\n" }, { [ALL_GREEN_WORKFLOW_PATH]: WORKFLOW });
    const r = runScript(root, ["--hide-details", "true"]);
    expect(r.exitCode).toBe(0);
    expect(r.report).toContain("FIRST VERDICT DELIVERY");
    expect(r.stdout).toContain("private repository");
    expect(r.stdout).not.toContain("does not carry");
  });

  test("a broken repository fails loudly instead of reading as 'absent at HEAD'", () => {
    const base = mkdtempSync(join(tmpdir(), "all-green-bootstrap-"));
    const root = join(base, "not-a-repo");
    mkdirSync(join(root, dirname(ALL_GREEN_WORKFLOW_PATH)), { recursive: true });
    writeFileSync(join(root, ALL_GREEN_WORKFLOW_PATH), WORKFLOW);
    const r = runScript(root);
    expect(r.exitCode).not.toBe(0);
    expect(r.report).toBe("");
  });

  test("a permission failure on the delivered-tree probe throws, never 'not delivered'", () => {
    if (process.getuid?.() === 0) return; // root ignores permission bits
    const root = makeTarget({ "README.md": "hi\n" }, { [ALL_GREEN_WORKFLOW_PATH]: WORKFLOW });
    chmodSync(join(root, ".github"), 0o000); // EACCES on the lstat, not ENOENT
    try {
      const r = runScript(root);
      expect(r.exitCode).not.toBe(0);
      expect(r.report).toBe("");
    } finally {
      chmodSync(join(root, ".github"), 0o755);
    }
  });
});
