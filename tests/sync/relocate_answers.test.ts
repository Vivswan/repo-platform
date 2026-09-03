import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/relocate_answers.ts");
const ANSWERS = "_commit: templates/v1.0.0\n_src_path: gh:Vivswan/repo-platform\n";

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
 * sync workflow's checkout lays it out; `files` maps relative paths to
 * content. `withGithubDir` seeds .github/ up front (most fleet repos carry
 * it); false models a minimal repo where the move must create it. */
function makeRoot(files: Record<string, string>, withGithubDir = true): string {
  const root = mkdtempSync(join(tmpdir(), "relocate-answers-"));
  const target = join(root, "target");
  mkdirSync(target, { recursive: true });
  if (withGithubDir) mkdirSync(join(target, ".github"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), content);
  }
  git(target, "init", "-b", "main");
  git(target, "config", "user.name", "test");
  git(target, "config", "user.email", "test@example.com");
  git(target, "add", "-A");
  git(target, "commit", "-qm", "target state");
  return root;
}

function runScript(root: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = boundedSpawnSync(["bun", script], {
    cwd: root,
    env: {
      ...gitFreeEnv(),
      RUNNER_TEMP: root,
      TARGET_DISPLAY: "Vivswan/demo",
    },
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr };
}

describe("relocate_answers", () => {
  test("a root-vintage answers file is moved byte-for-byte and committed", () => {
    const root = makeRoot({ ".copier-answers.yml": ANSWERS });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "target/.copier-answers.yml"))).toBe(false);
    // Byte identity is the point: the recorded answers feed the old-render
    // replay verbatim, so the move must not touch a single byte.
    expect(readFileSync(join(root, "target/.github/.copier-answers.yml"), "utf-8")).toBe(ANSWERS);
    // copier update refuses a dirty tree: the move must be committed.
    expect(git(join(root, "target"), "status", "--porcelain")).toBe("");
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(result.stdout).toContain("::notice::");
    // The move commits as the sync's own bot identity, like every other
    // sync-branch commit.
    expect(git(join(root, "target"), "log", "-1", "--format=%an").trim()).toBe(
      "repo-platform-sync",
    );
    // The PR-body note rides RUNNER_TEMP for open_pr.ts.
    expect(readFileSync(join(root, "answers-move.md"), "utf-8")).toContain("ANSWERS FILE MOVE");
  });

  test("the move creates .github/ when the target never had one", () => {
    const root = makeRoot({ ".copier-answers.yml": ANSWERS, "README.md": "hi\n" }, false);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "target/.github/.copier-answers.yml"), "utf-8")).toBe(ANSWERS);
    expect(git(join(root, "target"), "status", "--porcelain")).toBe("");
  });

  test("an already-moved answers file is a no-op with an empty note", () => {
    const root = makeRoot({ ".github/.copier-answers.yml": ANSWERS });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(git(join(root, "target"), "status", "--porcelain")).toBe("");
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(result.stdout).not.toContain("::notice::");
    expect(readFileSync(join(root, "answers-move.md"), "utf-8")).toBe("");
  });

  test("answers at both paths fail loudly (the sync must not guess)", () => {
    const root = makeRoot({
      ".copier-answers.yml": "_commit: stale\n",
      ".github/.copier-answers.yml": ANSWERS,
    });
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    // ::error:: on stdout: workflow commands only parse from there.
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("BOTH");
    // Nothing moved, nothing committed.
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("answers at neither path fail loudly with regeneration advice", () => {
    const root = makeRoot({ ".github/keep": "so .github exists in the commit\n" });
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    // Not recover=recopy: this step runs before recovery reaches copier,
    // and recopy itself needs a readable answers file.
    expect(result.stdout).toContain("copier copy");
  });

  test("a non-file at either answers path fails loudly, nothing moves", () => {
    const root = makeRoot({ ".copier-answers.yml/nested": "a directory, not the answers file\n" });
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("regular file");
    expect(existsSync(join(root, "target/.github/.copier-answers.yml"))).toBe(false);
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("a symlink at the destination path is refused, not read through", () => {
    // lstat, not stat: a symlink pointing at a perfectly good file is still
    // not the answers file - copier would write through it.
    const root = makeRoot({ ".github/target-of-link.yml": ANSWERS });
    symlinkSync("target-of-link.yml", join(root, "target/.github/.copier-answers.yml"));
    git(join(root, "target"), "add", "-A");
    git(join(root, "target"), "commit", "-qm", "symlinked answers");
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("regular file");
  });

  test("the move commit carries ONLY the rename, never other staged content", () => {
    const root = makeRoot({ ".copier-answers.yml": ANSWERS, "README.md": "hi\n" });
    // An unrelated change staged before the move (production starts clean;
    // this pins the pathspec isolation): it must stay behind, uncommitted,
    // to fail loudly at copier's dirty-tree check rather than smuggle
    // through on the move commit.
    writeFileSync(join(root, "target/README.md"), "edited\n");
    git(join(root, "target"), "add", "README.md");
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    const committed = git(
      join(root, "target"),
      "show",
      "--name-only",
      "--no-renames",
      "--format=",
      "HEAD",
    )
      .trim()
      .split("\n")
      .sort();
    expect(committed).toEqual([".copier-answers.yml", ".github/.copier-answers.yml"]);
    expect(git(join(root, "target"), "status", "--porcelain")).toContain("M  README.md");
  });
});
