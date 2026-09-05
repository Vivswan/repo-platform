// apply_update.ts run for real as a subprocess, so its postcondition on
// the written `_commit` is tested as an outcome. copier is a stub on PATH
// standing in for copier plus its stamp hook (the real one needs a
// template clone), in the workflow's layout: cwd is the repo-platform
// checkout holding the build commit, TARGET_REF is that sha, the target a
// plain directory beside it.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/apply_update.ts");

function fixture(written: (sha: string) => string, srcPath = "gh:o/r", srcPathEnv?: string) {
  const root = mkdtempSync(join(tmpdir(), "apply-update-"));
  try {
    return {
      ...build(root, written, srcPath, srcPathEnv),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function build(
  root: string,
  written: (sha: string) => string,
  srcPath: string,
  srcPathEnv: string | undefined,
) {
  const platform = join(root, "platform");
  mkdirSync(platform);
  const target = join(root, "target");
  mkdirSync(join(target, ".github"), { recursive: true });
  writeFileSync(join(target, ".github/.copier-answers.yml"), "_commit: stale\n");
  const git = (...args: string[]) => {
    const proc = boundedSpawnSync(["git", "-C", platform, ...args]);
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
    return proc.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-q", "--allow-empty", "-m", "b");
  const sha = git("rev-parse", "HEAD");
  // The stub rewrites the answers file with the value under test and
  // records its argv one argument per line (boundaries preserved).
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "copier"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > "${root}/copier-argv"`,
      `printf '_commit: %s\\n_src_path: %s\\n' '${written(sha)}' '${srcPath}' > .github/.copier-answers.yml`,
    ].join("\n"),
    { mode: 0o755 },
  );
  const proc = boundedSpawnSync(["bun", script], {
    cwd: platform,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      // Absent by default so the cwd resolution arm is the one exercised.
      SRC_PATH: srcPathEnv,
      TARGET_DIR: target,
      TARGET_REF: sha,
      MODULES: "[uv]",
      PRIVATE: "false",
      DESCRIPTION: "d",
      RECOVER: "",
    },
  });
  return {
    sha,
    proc,
    argv: readFileSync(join(root, "copier-argv"), "utf-8").trimEnd().split("\n"),
    answers: readFileSync(join(target, ".github/.copier-answers.yml"), "utf-8"),
  };
}

describe("apply_update.ts postcondition (subprocess)", () => {
  test("control: a render recording the pinned commit passes and the file is left as written", () => {
    const r = fixture((sha) => sha);
    try {
      expect(r.argv).toEqual([
        "update",
        "--answers-file",
        ".github/.copier-answers.yml",
        "--vcs-ref",
        r.sha,
        "--defaults",
        "--trust",
        "-d",
        "modules=[uv]",
        "-d",
        "private=false",
        "-d",
        "description=d",
      ]);
      expect(r.proc.exitCode).toBe(0);
      expect(r.answers).toBe(`_commit: ${r.sha}\n_src_path: gh:o/r\n`);
    } finally {
      r.cleanup();
    }
  });

  test("a render recording an abbreviation fails, naming the written and pinned values", () => {
    const r = fixture((sha) => sha.slice(0, 7));
    try {
      expect(r.proc.exitCode).toBe(1);
      expect(r.proc.stdout).toContain(
        `::error::copier recorded _commit '${r.sha.slice(0, 7)}' in .github/.copier-answers.yml, but the sync pinned it to commit ${r.sha}.`,
      );
      expect(r.proc.stdout).toContain("stamp hook rewrites that line");
    } finally {
      r.cleanup();
    }
  });

  test("a recorded _src_path the process cannot look at aborts instead of falling through to cwd", () => {
    // A control on "absent vs failed to look": the value is a real path
    // whose stat fails with EACCES (a parent without search permission),
    // not ENOENT. Silently skipping it would resolve TARGET_REF in cwd
    // and pass a render whose source was never examined.
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const locked = mkdtempSync(join(tmpdir(), "apply-update-locked-"));
    const inner = join(locked, "src");
    mkdirSync(inner);
    chmodSync(locked, 0o000);
    try {
      const r = fixture((sha) => sha, inner);
      try {
        expect(r.proc.exitCode).not.toBe(0);
        expect(r.proc.stderr).toContain("EACCES");
      } finally {
        r.cleanup();
      }
    } finally {
      chmodSync(locked, 0o700);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  test("a SRC_PATH git cannot answer for aborts instead of falling through to cwd", () => {
    // rev-parse exits 1 for an absent ref (fall through) but 128 for a
    // directory that is not a repository: a failure to look, which must
    // never let the cwd candidate vouch for a source nobody examined.
    const notARepo = mkdtempSync(join(tmpdir(), "apply-update-norepo-"));
    try {
      const r = fixture((sha) => sha, "gh:o/r", notARepo);
      try {
        expect(r.proc.exitCode).toBe(1);
        expect(r.proc.stdout).toContain(`::error::git rev-parse failed in ${notARepo} (exit 128)`);
      } finally {
        r.cleanup();
      }
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
