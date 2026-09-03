import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/normalize_src.ts");
const CANONICAL = "gh:Vivswan/repo-platform";

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

function git(dir: string, ...args: string[]): string {
  const proc = boundedSpawnSync(["git", "-C", dir, ...args], { env: gitFreeEnv() });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  }
  return proc.stdout;
}

/** A scratch root holding target/ as a one-commit git repo, the way the
 * sync workflow's checkout lays it out. */
function makeRoot(answers: string): string {
  const root = mkdtempSync(join(tmpdir(), "normalize-src-"));
  const target = join(root, "target");
  mkdirSync(join(target, ".github"), { recursive: true });
  writeFileSync(join(target, ".github/.copier-answers.yml"), answers);
  git(target, "init", "-b", "main");
  git(target, "config", "user.name", "test");
  git(target, "config", "user.email", "test@example.com");
  git(target, "add", "-A");
  git(target, "commit", "-qm", "target state");
  return root;
}

function runScript(
  root: string,
  extraEnv: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const proc = boundedSpawnSync(["bun", script], {
    cwd: root,
    env: {
      ...gitFreeEnv(),
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GITHUB_OUTPUT: join(root, "github-output.txt"),
      TARGET_DISPLAY: "Vivswan/demo",
      ...extraEnv,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
  };
}

describe("normalize_src", () => {
  test("a non-canonical recorded source is rewritten and committed", () => {
    const root = makeRoot(`_commit: templates/v1.0.0\n_src_path: /home/user/repo-platform\n`);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "target/.github/.copier-answers.yml"), "utf-8")).toContain(
      `_src_path: ${CANONICAL}`,
    );
    // copier update refuses a dirty tree: the rewrite must be committed.
    expect(git(join(root, "target"), "status", "--porcelain")).toBe("");
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toContain("/home/user/repo-platform");
  });

  test("an already-canonical line leaves the tree and history untouched", () => {
    const root = makeRoot(`_src_path: ${CANONICAL}\n`);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(git(join(root, "target"), "status", "--porcelain")).toBe("");
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(result.stdout).not.toContain("::notice::");
  });

  test("a value-equal but not byte-for-byte line is committed, not left dirty", () => {
    // The extracted value already matches the canonical source, but the
    // rewrite still reformats the line; an uncommitted reformat would
    // abort the copier update on a dirty tree.
    const root = makeRoot(`_src_path:   ${CANONICAL}\n`);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "target/.github/.copier-answers.yml"), "utf-8")).toBe(
      `_src_path: ${CANONICAL}\n`,
    );
    expect(git(join(root, "target"), "status", "--porcelain")).toBe("");
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(result.stdout).toContain("byte-for-byte");
  });

  test("a missing _src_path line fails loudly", () => {
    const root = makeRoot("_commit: templates/v1.0.0\n");
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    // ::error:: on stdout: workflow commands only parse from there.
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("no _src_path line");
  });

  test("a missing _src_path line stays detail-free for a hide-details target", () => {
    const root = makeRoot("_commit: templates/v1.0.0\n");
    const result = runScript(root, { HIDE_DETAILS: "true" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("detail hidden: private repository");
    expect(result.stdout).not.toContain("no _src_path line");
  });
});
