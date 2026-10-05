import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bunLockDirs,
  HOOKS_PATH,
  installHooks,
  missingNodeModules,
  runtimeMismatch,
} from "../../scripts/bootstrap";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const root = join(import.meta.dir, "../..");
const temp = tempDirs();

function plant(base: string, path: string, files: string[]): void {
  mkdirSync(join(base, path), { recursive: true });
  for (const file of files) writeFileSync(join(base, path, file), "");
}

describe("bunLockDirs", () => {
  // A dependency's own lockfile under node_modules would be installed as a workspace.
  test("a planted tree: no lock, a lock under node_modules, a nested lock", () => {
    const base = temp.dir("bootstrap-discovery-");
    plant(base, "actions/with-lock", ["bun.lock", "package.json"]);
    plant(base, "actions/with-lock/node_modules/dep", ["bun.lock"]);
    plant(base, "actions/without-lock", ["package.json"]);
    plant(base, "actions/parent/nested", ["bun.lock"]);

    const dirs = bunLockDirs(base);
    expect(dirs).toEqual(["actions/parent/nested", "actions/with-lock"]);
    expect(missingNodeModules(base, dirs)).toEqual(["actions/parent/nested"]);

    writeFileSync(join(base, "bun.lock"), "");
    expect(bunLockDirs(base)).toEqual([".", "actions/parent/nested", "actions/with-lock"]);
  });
});

/** bun.lock is JSON with trailing commas, so they go before the parse. */
function lockedName(dir: string): string {
  const lock = JSON.parse(
    readFileSync(join(root, dir, "bun.lock"), "utf-8").replace(/,(\s*[}\]])/g, "$1"),
  ) as { workspaces: Record<string, { name: string }> };
  return lock.workspaces[""].name;
}

// A frozen install accepts a stale workspace name (bun 1.4.0), so the
// lockfile of a renamed action is judged here instead.
test("every bun.lock names the package.json beside it", () => {
  const dirs = bunLockDirs(root);
  const named = (name: (dir: string) => string) => dirs.map((dir) => ({ dir, name: name(dir) }));
  expect(named(lockedName)).toEqual(
    named(
      (dir) =>
        (JSON.parse(readFileSync(join(root, dir, "package.json"), "utf-8")) as { name: string })
          .name,
    ),
  );
});

describe("installHooks", () => {
  // Git runs a hook only from an executable file and skips the rest without a word, and a tracked file's mode is what
  // every checkout gets. The content is the hook's own, so only the bit is pinned.
  test("the tracked pre-commit hook is executable", () => {
    expect(fixtureGit(root, ["ls-files", "-s", `${HOOKS_PATH}/pre-commit`])).toStartWith("100755 ");
  });

  // The named incident: a generated hook folder existed only where an install had run, so a fresh worktree committed
  // unchecked, and a stale checkout's absolute path ran its hooks in every sibling. The one relative setting is
  // written to the shared config and resolved against each worktree's own root, so the sibling runs its own file.
  test("a worktree added later, which never ran bootstrap, runs its own tracked hook", () => {
    const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
    const sentinel = (where: string) => `#!/bin/sh\necho hook-ran-in-${where} >&2\nexit 1\n`;
    const base = temp.dir("bootstrap-hooks-");
    const sibling = temp.dir("bootstrap-hooks-worktree-");
    const decoy = temp.dir("bootstrap-hooks-decoy-");
    for (const repo of [base, decoy]) fixtureGit(repo, ["init", "-q", "-b", "main"]);
    mkdirSync(join(base, HOOKS_PATH));
    writeFileSync(join(base, HOOKS_PATH, "pre-commit"), sentinel("base"), { mode: 0o755 });
    fixtureGit(base, ["add", "-A"]);
    fixtureGit(base, [...identity, "commit", "-q", "-m", "init"]);

    // A hook's exported GIT_DIR once rewrote this repository's config; the decoy is where a leaked one points.
    process.env.GIT_DIR = join(decoy, ".git");
    try {
      installHooks(base);
    } finally {
      delete process.env.GIT_DIR;
    }
    expect(fixtureGit(base, ["config", "--get", "core.hooksPath"])).toBe(HOOKS_PATH);
    const leaked = boundedSpawnSync(["git", "-C", decoy, "config", "--get", "core.hooksPath"], {
      env: fixtureGitEnv(),
    });
    expect([leaked.exitCode, leaked.stdout]).toEqual([1, ""]);

    fixtureGit(base, ["worktree", "add", "-q", sibling]);
    writeFileSync(join(sibling, HOOKS_PATH, "pre-commit"), sentinel("sibling"));
    writeFileSync(join(sibling, "note.txt"), "x\n");
    fixtureGit(sibling, ["add", "note.txt"]);
    const gated = boundedSpawnSync(
      ["git", "-C", sibling, ...identity, "commit", "-q", "-m", "gated"],
      {
        env: fixtureGitEnv(),
      },
    );
    expect([gated.exitCode, gated.stderr.trim()]).toEqual([1, "hook-ran-in-sibling"]);
    // The control: the same commit with hooks bypassed lands, so the refusal above was the hook's.
    fixtureGit(sibling, [...identity, "commit", "-q", "--no-verify", "-m", "gated"]);
    fixtureGit(base, ["worktree", "remove", "--force", sibling]);
  });
});

describe("runtimeMismatch", () => {
  // The named incident: a green run under 1.3 on a commit CI's 1.4 failed.
  const MISMATCH = (local: string) =>
    `local bun ${local} is not at the pinned 1.4 (files/bun/.bun-version)`;
  test.each<[string, string, { verdict: string | null } | { throws: string }]>([
    ["1.4.0", "1.4.0\n", { verdict: null }],
    ["1.4.3", "1.4.0\n", { verdict: null }],
    ["1.3.14", "1.4.0\n", { verdict: MISMATCH("1.3.14") }],
    ["2.0.0", "1.4.0\n", { verdict: MISMATCH("2.0.0") }],
    // A prerelease or an unreadable pin throws instead of reading a prefix.
    ["1.4.0-canary.1", "1.4.0\n", { throws: "the local bun runtime" }],
    ["1.4.0", "", { throws: "files/bun/.bun-version" }],
  ])("local %s against the pin %s", (local, pinned, outcome) => {
    if ("throws" in outcome) {
      expect(() => runtimeMismatch(local, pinned)).toThrow(outcome.throws);
      return;
    }
    const found = runtimeMismatch(local, pinned);
    if (outcome.verdict === null) expect(found).toBeNull();
    else expect(found).toStartWith(outcome.verdict);
  });
});
