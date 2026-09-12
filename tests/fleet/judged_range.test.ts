import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rangeCommits, rangeLabel, resolveBase } from "../../.github/scripts/fleet/judged_range.ts";
import { commitStampWrite } from "../../.github/scripts/shared/commit_stamp.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const ZEROS = "0".repeat(40);
// git's empty tree, the base a branch-creating push is read from.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("resolveBase", () => {
  const root = temp.dir("judged-range-");

  function git(cwd: string, args: string[]): string {
    return fixtureGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@x.test", ...args]);
  }

  // Each scenario is a clone of a bare origin, so the build branch sits where the leg reads it:
  // refs/remotes/origin/build.
  const source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  function commit(message: string): string {
    git(source, ["commit", "-q", "--allow-empty", "-m", message]);
    return git(source, ["rev-parse", "HEAD"]);
  }
  const c0 = commit("root");
  const c1 = commit("published");
  const c2 = commit("superseded push");
  const c3 = commit("judged");
  const c4 = commit("tip");
  git(source, ["checkout", "-q", "-b", "side", c0]);
  const side = commit("side");
  git(source, ["checkout", "-q", "main"]);

  function cloneWithBuild(name: string, stamps: string[] | null): string {
    const bare = join(root, `${name}.git`);
    git(root, ["clone", "-q", "--bare", source, bare]);
    if (stamps !== null) {
      const scratch = join(root, `${name}-build`);
      git(root, ["clone", "-q", bare, scratch]);
      git(scratch, ["checkout", "-q", "--orphan", "build"]);
      for (const [index, stamped] of stamps.entries()) {
        writeFileSync(join(scratch, "tree.txt"), `${index}\n`);
        git(scratch, ["add", "-A"]);
        const stamp =
          stamped === "" ? "" : `\n\n${commitStampWrite("https://x.test", "o/r", stamped)}`;
        git(scratch, ["commit", "-q", "-m", `build${stamp}\nrun: https://x.test/run`]);
      }
      git(scratch, ["push", "-q", "origin", "build"]);
    }
    const clone = join(root, name);
    git(root, ["clone", "-q", bare, clone]);
    return clone;
  }

  const unpublished = cloneWithBuild("unpublished", null);
  const publishedC1 = cloneWithBuild("published-c1", [c1]);
  const publishedC1C3 = cloneWithBuild("published-c1-c3", [c1, c3]);
  const publishedC0C1 = cloneWithBuild("published-c0-c1", [c0, c1]);
  const publishedC1C3C4 = cloneWithBuild("published-c1-c3-c4", [c1, c3, c4]);
  const publishedC1C4 = cloneWithBuild("published-c1-c4", [c1, c4]);
  const publishedC4 = cloneWithBuild("published-c4", [c4]);
  const deepStamp = cloneWithBuild("deep", [c1, ...Array.from({ length: 30 }, () => "")]);
  const tamperedStamp = cloneWithBuild("tampered", [side]);
  const stampless = cloneWithBuild("stampless", [""]);

  const short = (sha: string) => sha.slice(0, 12);

  function read(cwd: string, sha: string, before: string) {
    const base = resolveBase(cwd, sha, before);
    return { base, commits: rangeCommits(cwd, sha, base), label: rangeLabel(sha, base) };
  }

  type Row = { reason: string; cwd: string; sha: string; before: string } & Pick<
    ReturnType<typeof read>,
    "base" | "commits"
  >;
  test.each<Row>([
    {
      reason:
        "the coalescing case: a superseded push is covered from the stamped base, not the push's own before",
      cwd: publishedC1,
      sha: c3,
      before: c2,
      base: { kind: "build-stamp", base: c1 },
      commits: [c2, c3],
    },
    {
      reason: "a build tip already stamped with the judged sha (this run's publish landed first)",
      cwd: publishedC1C3,
      sha: c3,
      before: c2,
      base: { kind: "build-stamp", base: c1 },
      commits: [c2, c3],
    },
    {
      reason: "the newest of several ancestor stamps, not the oldest",
      cwd: publishedC0C1,
      sha: c3,
      before: c2,
      base: { kind: "build-stamp", base: c1 },
      commits: [c2, c3],
    },
    {
      reason:
        "a re-run after a later commit published: the tip stamps a descendant, the judged commit's own stamp is skipped, the newest ancestor stamp is the base",
      cwd: publishedC1C3C4,
      sha: c3,
      before: c2,
      base: { kind: "build-stamp", base: c1 },
      commits: [c2, c3],
    },
    {
      reason:
        "a later commit published and the judged commit's own publish was skipped (a re-run after no tree change, or a neighbouring run's newer publish tops the branch): walked past to the newest ancestor stamp",
      cwd: publishedC1C4,
      sha: c3,
      before: c2,
      base: { kind: "build-stamp", base: c1 },
      commits: [c2, c3],
    },
    {
      reason:
        "every stamp is a newer publish (the first publish ever, landed by a neighbouring run): the fallback before",
      cwd: publishedC4,
      sha: c3,
      before: c2,
      base: { kind: "fallback", base: c2 },
      commits: [c3],
    },
    {
      reason: "thirty unstamped build commits above the one real stamp (no walk bound)",
      cwd: deepStamp,
      sha: c3,
      before: c2,
      base: { kind: "build-stamp", base: c1 },
      commits: [c2, c3],
    },
    {
      reason: "a stamp beats an all-zero before",
      cwd: publishedC1,
      sha: c3,
      before: ZEROS,
      base: { kind: "build-stamp", base: c1 },
      commits: [c2, c3],
    },
    {
      reason: "no build branch: the fallback before, with a notice-worthy kind",
      cwd: unpublished,
      sha: c3,
      before: c2,
      base: { kind: "fallback", base: c2 },
      commits: [c3],
    },
    {
      reason: "no build branch and a branch-creating push: the empty tree, so the whole history",
      cwd: unpublished,
      sha: c1,
      before: ZEROS,
      base: { kind: "empty-tree", base: EMPTY_TREE },
      commits: [c0, c1],
    },
  ])("$reason", ({ cwd, sha, before, base, commits }) => {
    expect(read(cwd, sha, before)).toEqual({
      base,
      commits,
      label: `${short(base.base)}..${short(sha)}`,
    });
  });

  const notAncestor = (what: string, base: string, sha: string) =>
    `${what} ${short(base)} is not an ancestor of ${short(sha)}: the range means nothing ` +
    "(a force-push, a foreign payload, or a tampered build stamp) - publish a green main commit " +
    "by hand (dispatch post-green.yml with sha=<green main commit>) to reset the base";
  test.each([
    {
      reason:
        "a fallback base that is no ancestor of the judged commit (a foreign or force-pushed payload)",
      cwd: unpublished,
      sha: c3,
      before: side,
      error: notAncestor("the fallback base", side, c3),
    },
    {
      reason: "a build stamp naming a commit off main (tampered), even with a sound before",
      cwd: tamperedStamp,
      sha: c3,
      before: c2,
      error: notAncestor("the build tip's stamped source", side, c3),
    },
    {
      reason:
        "a build branch with no stamp anywhere (not published by publish.ts), never a silent fallback",
      cwd: stampless,
      sha: c3,
      before: c2,
      error:
        "the build branch carries no stamped source in its whole history: publish.ts stamps every build commit, so this branch was not published by it - reset it (dispatch post-green.yml with sha=<green main commit>) before the post-green legs read it",
    },
    {
      reason: "a fallback base equal to the judged commit (an empty range)",
      cwd: unpublished,
      sha: c3,
      before: c3,
      error: `the fallback base ${short(c3)} is the judged commit itself: an empty range reads nothing`,
    },
  ])("$reason is refused", ({ cwd, sha, before, error }) => {
    expect(() => resolveBase(cwd, sha, before)).toThrow(error);
  });

  test("a base the checkout cannot see is refused, never read as an empty or a full range", () => {
    const shallow = join(root, "shallow");
    git(root, ["clone", "-q", "--depth", "1", `file://${source}`, shallow]);
    expect(() => resolveBase(shallow, c4, c2)).toThrow(
      `the fallback base ${short(c2)} is not in this checkout: fetch the full history (actions/checkout fetch-depth: 0)`,
    );
  });

  test("a git that errors on the resolve question is fatal at the leg, never read as an absent commit", () => {
    // The stub errors on the build ref's resolve alone and hands every other call to the real git: erroring on
    // every quiet rev-parse would let a swallowed build-ref error pass, since the fallback's own resolve of
    // BEFORE_SHA then throws the same words.
    const real = Bun.which("git");
    if (real === null) throw new Error("git is not on PATH");
    const bin = join(root, "erroring-git-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env bash",
        `if [ "$1" = rev-parse ] && [ "$4" = 'refs/remotes/origin/build^{commit}' ]; then echo 'fatal: stubbed' >&2; exit 128; fi`,
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const script = join(import.meta.dir, "../../.github/scripts/fleet/fleet_sync_marker.ts");
    const outputFile = join(root, "erroring-git-output.txt");
    writeFileSync(outputFile, "");
    const result = boundedSpawnSync(["bun", script], {
      cwd: publishedC1,
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

  test("a malformed base is refused by the leg's entry point before any git read, with no output line", () => {
    // judgedRangeEnv fails the process, so the whole outcome is the leg's:
    // fleet_sync_marker.ts is the one script that reads the range env.
    const script = join(import.meta.dir, "../../.github/scripts/fleet/fleet_sync_marker.ts");
    const outputFile = join(root, "malformed-before-output.txt");
    writeFileSync(outputFile, "");
    const result = boundedSpawnSync(["bun", script], {
      cwd: publishedC1,
      env: { ...process.env, SOURCE_SHA: c3, BEFORE_SHA: "main", GITHUB_OUTPUT: outputFile },
    });
    expect({ ...result, output: readFileSync(outputFile, "utf-8") }).toEqual({
      exitCode: 1,
      stdout: "::error::BEFORE_SHA is not a full commit sha (got 'main')\n",
      stderr: "",
      output: "",
    });
  });
});
