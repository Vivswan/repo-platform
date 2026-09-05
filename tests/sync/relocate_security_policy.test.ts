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

const script = join(import.meta.dir, "../../.github/scripts/sync/relocate_security_policy.ts");
const REGION =
  "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Security policy\n<!-- END REPO-PLATFORM MANAGED -->\n";
// The repository-owned half is the whole point of the move: it must ride
// the rename byte-for-byte, trailing whitespace and all.
const POLICY = `${REGION}\nScope note: repo-owned tail  \n`;

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
 * content. */
function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "relocate-security-"));
  const target = join(root, "target");
  mkdirSync(join(target, ".github"), { recursive: true });
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
    env: { ...gitFreeEnv(), RUNNER_TEMP: root, TARGET_DISPLAY: "Vivswan/demo" },
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr };
}

describe("relocate_security_policy", () => {
  test("a root-vintage SECURITY.md is moved byte-for-byte, tail included, and committed", () => {
    const root = makeRoot({ "SECURITY.md": POLICY, ".github/keep": "" });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "target/SECURITY.md"))).toBe(false);
    expect(readFileSync(join(root, "target/.github/SECURITY.md"), "utf-8")).toBe(POLICY);
    // copier update refuses a dirty tree: the move must be committed, as
    // the sync's own bot identity like every other sync-branch commit.
    expect(git(join(root, "target"), "status", "--porcelain")).toBe("");
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(git(join(root, "target"), "log", "-1", "--format=%an").trim()).toBe(
      "repo-platform-sync",
    );
    // git records the rename, so history follows the file to its new path.
    expect(git(join(root, "target"), "log", "-1", "--name-status", "--format=")).toContain(
      "R100\tSECURITY.md\t.github/SECURITY.md",
    );
    expect(result.stdout).toContain("::notice::");
    expect(readFileSync(join(root, "security-move.md"), "utf-8")).toContain("SECURITY POLICY MOVE");
  });

  const MOVE_NOTE =
    "> [!NOTE]\n> SECURITY POLICY MOVE: this update moves `SECURITY.md` to\n> `.github/SECURITY.md`, byte-for-byte - the repository's own content outside\n> the managed region rides the move verbatim, and GitHub reads the policy\n> from `.github/` exactly as it did from the root. One-time transition:\n> the repository root keeps only repo content plus `.repo-platform.yml`;\n> community health files live under `.github/`.\n";
  const MIRROR_ADVICE =
    "> This repository's `.repo-platform.yml` declares a `mirrors` source at the\n> retired path: change `source: SECURITY.md` to\n> `source: .github/SECURITY.md`. Until then the mirror step refuses that entry\n> and holds the PR.\n";
  const STALE_MIRROR =
    "modules: [bun]\nmirrors:\n  - source: SECURITY.md\n    targets: [copies/SECURITY.md]\n";

  test.each([
    [
      "moved, stale mirror source",
      { "SECURITY.md": POLICY, ".repo-platform.yml": STALE_MIRROR },
      `${MOVE_NOTE}>\n${MIRROR_ADVICE}`,
    ],
    [
      "moved, another mirror source",
      {
        "SECURITY.md": POLICY,
        ".repo-platform.yml":
          "modules: [bun]\nmirrors:\n  - source: LICENSE.md\n    targets: [x.md]\n",
      },
      MOVE_NOTE,
    ],
    [
      "moved, no mirrors",
      { "SECURITY.md": POLICY, ".repo-platform.yml": "modules: [bun]\n" },
      MOVE_NOTE,
    ],
    [
      "already moved, stale mirror source",
      { ".github/SECURITY.md": POLICY, ".repo-platform.yml": STALE_MIRROR },
      `> [!NOTE]\n${MIRROR_ADVICE}`,
    ],
    [
      "missing, stale mirror source",
      { ".github/keep": "", ".repo-platform.yml": STALE_MIRROR },
      `> [!NOTE]\n${MIRROR_ADVICE}`,
    ],
  ])("the PR-body note is exact: %s", (_label, files, note) => {
    const root = makeRoot(files);
    expect(runScript(root).exitCode).toBe(0);
    expect(readFileSync(join(root, "security-move.md"), "utf-8")).toBe(note);
  });

  test.each([
    ["already moved", { ".github/SECURITY.md": POLICY }],
    ["at neither path (the update renders it fresh)", { ".github/keep": "" }],
  ])("a policy %s is a no-op with an empty note", (_label, files) => {
    const root = makeRoot(files);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(git(join(root, "target"), "status", "--porcelain")).toBe("");
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(result.stdout).not.toContain("::notice::");
    expect(readFileSync(join(root, "security-move.md"), "utf-8")).toBe("");
  });

  test("a policy at both paths fails loudly (the sync must not guess which wins)", () => {
    const root = makeRoot({ "SECURITY.md": "root copy\n", ".github/SECURITY.md": POLICY });
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    // ::error:: on stdout: workflow commands only parse from there.
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("BOTH");
    expect(readFileSync(join(root, "target/SECURITY.md"), "utf-8")).toBe("root copy\n");
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("a directory at the root path fails loudly, nothing moves", () => {
    const root = makeRoot({ "SECURITY.md/nested": "a directory, not the policy\n" });
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("regular file");
    expect(existsSync(join(root, "target/.github/SECURITY.md"))).toBe(false);
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("a symlink at the destination path is refused, not read through", () => {
    // lstat, not stat: a symlink pointing at a perfectly good file is still
    // not the policy - the carry would write through it.
    const root = makeRoot({ ".github/target-of-link.md": POLICY, "SECURITY.md": POLICY });
    symlinkSync("target-of-link.md", join(root, "target/.github/SECURITY.md"));
    git(join(root, "target"), "add", "-A");
    git(join(root, "target"), "commit", "-qm", "symlinked policy");
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("regular file");
    expect(readFileSync(join(root, "target/SECURITY.md"), "utf-8")).toBe(POLICY);
    expect(git(join(root, "target"), "rev-list", "--count", "HEAD").trim()).toBe("2");
  });
});
