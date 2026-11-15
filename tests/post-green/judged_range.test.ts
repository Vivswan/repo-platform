import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  rangeCommits,
  rangeLabel,
  resolveBase,
} from "../../.github/scripts/post-green/judged_range.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const ZEROS = "0".repeat(40);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("resolveBase", () => {
  function git(cwd: string, args: string[]): string {
    return fixtureGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@x.test", ...args]);
  }

  let root: string;
  let c0: string;
  let c1: string;
  let c2: string;
  let c3: string;
  let c4: string;
  let side: string;
  let clone: string;
  let shallow: string;
  beforeAll(() => {
    root = temp.dir("judged-range-");
    const source = join(root, "source");
    mkdirSync(source);
    git(source, ["init", "-q", "-b", "main"]);
    function commit(message: string): string {
      git(source, ["commit", "-q", "--allow-empty", "-m", message]);
      return git(source, ["rev-parse", "HEAD"]);
    }
    c0 = commit("root");
    c1 = commit("the tag's previous commit");
    c2 = commit("superseded push");
    c3 = commit("judged");
    c4 = commit("tip");
    git(source, ["checkout", "-q", "-b", "side", c0]);
    side = commit("side");
    git(source, ["checkout", "-q", "main"]);

    // The leg runs in a clone of the pushed repository, as actions/checkout leaves it.
    clone = join(root, "clone");
    git(root, ["clone", "-q", source, clone]);
    shallow = join(root, "shallow");
    git(root, ["clone", "-q", "--depth", "1", `file://${source}`, shallow]);
  });

  const short = (sha: string) => sha.slice(0, 12);

  function read(cwd: string, sha: string, before: string) {
    const base = resolveBase(cwd, sha, before);
    return { base, commits: rangeCommits(cwd, sha, base), label: rangeLabel(sha, base) };
  }

  type Row = { sha: string; before: string } & Pick<ReturnType<typeof read>, "base" | "commits">;
  test.each<{ reason: string; row: () => Row }>([
    {
      reason:
        "the coalescing case: the tag's previous commit covers a superseded push, not the push's own before",
      row: () => ({ sha: c3, before: c1, base: { kind: "commit", base: c1 }, commits: [c2, c3] }),
    },
    {
      reason: "the push's own before (the tag did not move): the judged commit alone",
      row: () => ({ sha: c3, before: c2, base: { kind: "commit", base: c2 }, commits: [c3] }),
    },
    {
      reason: "a branch-creating push: the empty tree, so the whole history",
      row: () => ({
        sha: c1,
        before: ZEROS,
        base: { kind: "empty-tree", base: EMPTY_TREE },
        commits: [c0, c1],
      }),
    },
  ])("$reason", ({ row }) => {
    const { sha, before, base, commits } = row();
    expect(read(clone, sha, before)).toEqual({
      base,
      commits,
      label: `${short(base.base)}..${short(sha)}`,
    });
  });

  // An equal base read as an empty range would arm nothing silently; an unseen base as a full one.
  test.each([
    {
      reason:
        "a base that is no ancestor of the judged commit (a force-push or an out-of-band tag move)",
      row: () => ({
        cwd: clone,
        sha: c3,
        before: side,
        error:
          `the base ${short(side)} is not an ancestor of ${short(c3)}: the range means nothing ` +
          "(a force-push, a foreign payload, or a tag moved out of band) - the next push to main reads " +
          "from this run's move; dispatch sync-repos.yml by hand for this commit's opt-in",
      }),
    },
    {
      reason: "a base equal to the judged commit (an empty range)",
      row: () => ({
        cwd: clone,
        sha: c3,
        before: c3,
        error: `the base ${short(c3)} is the judged commit itself: an empty range reads nothing`,
      }),
    },
    {
      reason: "a base a depth-1 checkout cannot see",
      row: () => ({
        cwd: shallow,
        sha: c4,
        before: c2,
        error: `the base ${short(c2)} is not in this checkout: fetch the full history (actions/checkout fetch-depth: 0)`,
      }),
    },
  ])("$reason is refused", ({ row }) => {
    const { cwd, sha, before, error } = row();
    expect(() => resolveBase(cwd, sha, before)).toThrow(error);
  });

  test("a git that errors on the resolve question is fatal at the leg, never read as an absent commit", () => {
    // The stub errors on the base's resolve alone and hands every other call to the real git.
    const real = Bun.which("git");
    if (real === null) throw new Error("git is not on PATH");
    const bin = join(root, "erroring-git-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env bash",
        `if [ "$1" = rev-parse ] && [ "$4" = '${c2}^{commit}' ]; then echo 'fatal: stubbed' >&2; exit 128; fi`,
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const script = join(import.meta.dir, "../../.github/scripts/post-green/fleet_sync_marker.ts");
    const outputFile = join(root, "erroring-git-output.txt");
    writeFileSync(outputFile, "");
    const result = boundedSpawnSync(["bun", script], {
      cwd: clone,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SOURCE_SHA: c3,
        BEFORE_SHA: c2,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_OUTPUT: outputFile,
      },
    });
    expect({ ...result, output: readFileSync(outputFile, "utf-8") }).toEqual({
      exitCode: 1,
      stdout:
        "::error::git rev-parse could not answer (exit 128); refusing to guess: fatal: stubbed\n",
      stderr: "",
      output: "",
    });
  });
});
