// apply_update.ts run for real as a subprocess: one outcome table over
// every way TARGET_REF resolves (or fails to) and every way the written
// `_commit` can disagree with it. copier is a stub on PATH standing in for
// copier plus its stamp hook, in the workflow's layout: cwd is the
// repo-platform checkout, TARGET_REF the ref to resolve, the target a
// plain directory beside it. Resolution happens BEFORE copier runs, so a
// row whose resolution fails leaves the pre-render answers file
// untouched and never invokes copier.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/apply_update.ts");
const STALE = "_commit: stale\n";

/** Where a repository or path candidate lives in the fixture: `src` holds
 *  the build commit (branch `build`, annotated tag `v1`); `cwd` is the
 *  sync checkout, a clone of src when `cwdHasCommit`, else an unrelated
 *  repository; `other` is a repository without the commit (rev-parse exits
 *  1); `norepo` is a plain directory (exit 128); `locked` is a path under a
 *  parent without search permission (EACCES). */
type Place = "src" | "other" | "norepo" | "locked";

interface Row {
  reason: string;
  targetRef?: (sha: string) => string;
  srcPathEnv?: Place;
  recordedSrcPath?: Place | "remote";
  cwdHasCommit?: boolean;
  written?: (sha: string) => string;
  exitCode: number;
  stdout?: (ctx: { sha: string; place: (p: Place) => string }) => string;
  stderr?: string;
  /** The answers file after the run: the stub's output, or the untouched
   *  pre-render file when copier never ran. `src` is the recorded
   *  _src_path as the fixture wrote it. */
  answers: (ctx: { sha: string; src: string }) => string;
  copierRan: boolean;
}

function gitIn(cwd: string) {
  return (...args: string[]) => {
    const proc = boundedSpawnSync(["git", "-C", cwd, ...args]);
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
    return proc.stdout.trim();
  };
}

function run(row: Row) {
  const root = mkdtempSync(join(tmpdir(), "apply-update-"));
  const locked = join(root, "locked");
  try {
    const src = join(root, "src");
    mkdirSync(src);
    const git = gitIn(src);
    git("init", "-q", "-b", "build");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t.test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "b",
    );
    const sha = git("rev-parse", "HEAD");
    git("-c", "user.name=t", "-c", "user.email=t@t.test", "tag", "-a", "v1", "-m", "v1");
    const other = join(root, "other");
    mkdirSync(other);
    gitIn(other)("init", "-q", "-b", "main");
    gitIn(other)(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t.test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "o",
    );
    const norepo = join(root, "norepo");
    mkdirSync(norepo);
    mkdirSync(join(locked, "src"), { recursive: true });
    chmodSync(locked, 0o000);
    const cwd = join(root, "platform");
    if (row.cwdHasCommit ?? true) {
      gitIn(root)("clone", "-q", src, cwd);
    } else {
      mkdirSync(cwd);
      gitIn(cwd)("init", "-q", "-b", "main");
      gitIn(cwd)(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t.test",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "p",
      );
    }
    const place = (p: Place) => ({ src, other, norepo, locked: join(locked, "src") })[p];
    const target = join(root, "target");
    mkdirSync(join(target, ".github"), { recursive: true });
    const recordedSrc =
      row.recordedSrcPath === undefined || row.recordedSrcPath === "remote"
        ? "gh:o/r"
        : place(row.recordedSrcPath);
    writeFileSync(
      join(target, ".github/.copier-answers.yml"),
      `${STALE}_src_path: ${recordedSrc}\n`,
    );
    const written = (row.written ?? ((s) => s))(sha);
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "copier"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" > "${root}/copier-argv"`,
        `printf '_commit: %s\\n_src_path: %s\\n' '${written}' '${recordedSrc}' > .github/.copier-answers.yml`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const proc = boundedSpawnSync(["bun", script], {
      cwd,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SRC_PATH: row.srcPathEnv === undefined ? undefined : place(row.srcPathEnv),
        TARGET_DIR: target,
        TARGET_REF: (row.targetRef ?? ((s) => s))(sha),
        MODULES: "[uv]",
        PRIVATE: "false",
        DESCRIPTION: "d",
        RECOVER: "",
      },
    });
    const argvPath = join(root, "copier-argv");
    return {
      sha,
      place,
      proc,
      recordedSrc,
      copierRan: existsSync(argvPath),
      argv: existsSync(argvPath) ? readFileSync(argvPath, "utf-8").trimEnd().split("\n") : [],
      answers: readFileSync(join(target, ".github/.copier-answers.yml"), "utf-8"),
    };
  } finally {
    chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

const asWritten = ({ sha, src }: { sha: string; src: string }) =>
  `_commit: ${sha}\n_src_path: ${src}\n`;
const untouched = ({ src }: { src: string }) => `${STALE}_src_path: ${src}\n`;

describe("apply_update.ts outcomes (subprocess)", () => {
  const rows: Row[] = [
    { reason: "cwd resolves the pinned sha", exitCode: 0, answers: asWritten, copierRan: true },
    {
      reason: "SRC_PATH resolves it when cwd cannot",
      srcPathEnv: "src",
      cwdHasCommit: false,
      exitCode: 0,
      answers: asWritten,
      copierRan: true,
    },
    {
      reason: "the recorded local _src_path resolves it when cwd cannot",
      recordedSrcPath: "src",
      cwdHasCommit: false,
      exitCode: 0,
      answers: asWritten,
      copierRan: true,
    },
    {
      reason: "a SRC_PATH repository without the ref (exit 1) falls through to cwd",
      srcPathEnv: "other",
      exitCode: 0,
      answers: asWritten,
      copierRan: true,
    },
    {
      reason: "no candidate resolves it: refused before copier runs",
      cwdHasCommit: false,
      exitCode: 1,
      stdout: ({ sha }) => `::error::cannot resolve TARGET_REF '${sha}' to a commit in .`,
      answers: untouched,
      copierRan: false,
    },
    {
      reason: "a branch name resolves to its commit and copier gets the sha",
      targetRef: () => "build",
      exitCode: 0,
      answers: asWritten,
      copierRan: true,
    },
    {
      reason: "an annotated tag peels to its commit",
      targetRef: () => "v1",
      exitCode: 0,
      answers: asWritten,
      copierRan: true,
    },
    {
      reason: "a recorded _src_path the process cannot look at (EACCES) aborts, not falls through",
      recordedSrcPath: "locked",
      exitCode: 1,
      stderr: "EACCES",
      answers: untouched,
      copierRan: false,
    },
    {
      reason: "a valid SRC_PATH answers before a broken recorded _src_path is ever looked at",
      srcPathEnv: "src",
      recordedSrcPath: "locked",
      cwdHasCommit: false,
      exitCode: 0,
      answers: asWritten,
      copierRan: true,
    },
    {
      reason: "a SRC_PATH that is not a repository (exit 128) aborts, not falls through",
      srcPathEnv: "norepo",
      exitCode: 1,
      stdout: ({ place }) => `::error::git rev-parse failed in ${place("norepo")} (exit 128)`,
      answers: untouched,
      copierRan: false,
    },
    {
      reason: "a render recording the abbreviation fails, naming both values",
      written: (sha) => sha.slice(0, 7),
      exitCode: 1,
      stdout: ({ sha }) =>
        `::error::copier recorded _commit '${sha.slice(0, 7)}' in .github/.copier-answers.yml, but the sync pinned it to commit ${sha}.`,
      answers: ({ sha, src }) => `_commit: ${sha.slice(0, 7)}\n_src_path: ${src}\n`,
      copierRan: true,
    },
  ];

  test.each(rows)("$reason", (row) => {
    if (row.recordedSrcPath === "locked" && process.getuid?.() === 0) return; // root ignores mode bits
    const r = run(row);
    expect(r.proc.exitCode).toBe(row.exitCode);
    if (row.stdout) expect(r.proc.stdout).toContain(row.stdout({ sha: r.sha, place: r.place }));
    if (row.stderr) expect(r.proc.stderr).toContain(row.stderr);
    expect(r.copierRan).toBe(row.copierRan);
    if (row.copierRan) {
      // copier is always handed the RESOLVED sha, whatever TARGET_REF was.
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
    }
    expect(r.answers).toBe(row.answers({ sha: r.sha, src: r.recordedSrc }));
  });
});
