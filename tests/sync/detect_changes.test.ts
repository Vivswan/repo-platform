// detect_changes.ts: the "anything to deliver?" verdict over a real
// target checkout. A fixture repo whose origin/<upstream> ref is set by
// hand plays the checked-out branch; the cases cover a clean tree at the
// upstream, uncommitted output, commits ahead, and the two git failures.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const script = join(import.meta.dir, "../../.github/scripts/sync/detect_changes.ts");

interface Fixture {
  work: string;
  target: string;
  output: string;
}

/** A work dir holding `target/`: one commit on main, with origin/main
 *  pointing at it. */
function fixture(): Fixture {
  const work = temp.dir("detect-changes-");
  const target = join(work, "target");
  mkdirSync(target);
  fixtureGit(target, ["init", "-q", "-b", "main"]);
  fixtureGit(target, ["config", "user.name", "fixture"]);
  fixtureGit(target, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(target, "README.md"), "hello\n");
  fixtureGit(target, ["add", "-A"]);
  fixtureGit(target, ["commit", "-q", "-m", "base"]);
  fixtureGit(target, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const output = join(work, "output.txt");
  writeFileSync(output, "");
  return { work, target, output };
}

function run(fx: Fixture, env: Record<string, string | undefined> = {}) {
  const proc = boundedSpawnSync(["bun", script], {
    cwd: fx.work,
    env: {
      ...fixtureGitEnv(),
      UPSTREAM: "main",
      DISPLAY: "build 2026-09-09",
      TARGET_DISPLAY: "Vivswan/managed",
      GITHUB_OUTPUT: fx.output,
      ...env,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    output: readFileSync(fx.output, "utf-8"),
  };
}

describe("detect_changes.ts", () => {
  test("a clean tree at the upstream has nothing to deliver, and says so publicly", () => {
    expect(run(fixture())).toEqual({
      exitCode: 0,
      stdout: "::notice::Vivswan/managed: already matches build 2026-09-09; nothing to deliver.\n",
      stderr: "",
      output: "changed=false\n",
    });
  });

  test("uncommitted output is a change", () => {
    const fx = fixture();
    writeFileSync(join(fx.target, "README.md"), "changed\n");
    expect(run(fx)).toEqual({ exitCode: 0, stdout: "", stderr: "", output: "changed=true\n" });
  });

  test("a commit already on the branch (a rung's, a normalization's) is a change with a clean tree", () => {
    const fx = fixture();
    writeFileSync(join(fx.target, "SECURITY.md"), "policy\n");
    fixtureGit(fx.target, ["add", "-A"]);
    fixtureGit(fx.target, ["commit", "-q", "-m", "m0001"]);
    expect(run(fx)).toEqual({ exitCode: 0, stdout: "", stderr: "", output: "changed=true\n" });
  });

  /** A PATH whose git runs `statusLine` before delegating a status call to
   *  the real git (every other call passes straight through). */
  function gitWithStatusPrelude(fx: Fixture, statusLine: string): string {
    const bin = join(fx.work, "bin");
    mkdirSync(bin);
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("git not on PATH");
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env bash",
        `if [ "$3" = status ]; then ${statusLine}; fi`,
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return `${bin}:${process.env.PATH}`;
  }

  test("a failed status is a red step that publishes nothing - never a clean tree", () => {
    const fx = fixture();
    const PATH = gitWithStatusPrelude(fx, 'echo "fatal: stub status failure" >&2; exit 128');
    expect(run(fx, { PATH })).toEqual({
      exitCode: 1,
      stdout: "::error::git status failed in the target checkout\n",
      stderr: "fatal: stub status failure\n",
      output: "",
    });
  });

  test("a green status still replays its diagnostics, as the inherited stderr did", () => {
    const fx = fixture();
    const PATH = gitWithStatusPrelude(fx, 'echo "warning: stub fsmonitor unavailable" >&2');
    expect(run(fx, { PATH })).toEqual({
      exitCode: 0,
      stdout: "::notice::Vivswan/managed: already matches build 2026-09-09; nothing to deliver.\n",
      stderr: "warning: stub fsmonitor unavailable\n",
      output: "changed=false\n",
    });
  });

  test("an upstream ref git cannot resolve fails the step instead of counting as changed", () => {
    const result = run(fixture(), { UPSTREAM: "no-such-branch" });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toBe("");
  });
});
