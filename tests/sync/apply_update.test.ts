// apply_update.ts run for real as a subprocess, so its postcondition on
// the written `_commit` is tested as an outcome. copier is a stub on PATH
// standing in for copier plus its stamp hook (the real one needs a
// template clone), in the workflow's layout: cwd is the repo-platform
// checkout holding the build commit, TARGET_REF is that sha, the target a
// plain directory beside it.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/apply_update.ts");

function fixture(written: (sha: string) => string) {
  const root = mkdtempSync(join(tmpdir(), "apply-update-"));
  try {
    return {
      ...build(root, written),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function build(root: string, written: (sha: string) => string) {
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
      `printf '_commit: %s\\n_src_path: gh:o/r\\n' '${written(sha)}' > .github/.copier-answers.yml`,
    ].join("\n"),
    { mode: 0o755 },
  );
  const proc = boundedSpawnSync(["bun", script], {
    cwd: platform,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      // The cwd resolution arm is the one under test.
      SRC_PATH: undefined,
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
});
