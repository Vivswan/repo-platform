import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Directive,
  FLEET_SYNC_LABELS,
  readDirective,
} from "../../.github/scripts/fleet/fleet_sync_marker.ts";
import { commitStampWrite } from "../../.github/scripts/shared/commit_stamp.ts";
import { argvStub } from "../shared/argv_stub";
import { type BoundedSpawnResult, boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const PUBLIC: Directive = { kind: "fleet-sync", scope: "public" };
const ALL: Directive = { kind: "fleet-sync", scope: "all" };
const NONE: Directive = { kind: "none" };
const TWO_SCOPES = "2 fleet-sync labels (fleet-sync:all, fleet-sync:public): one scope per merge";
const UNKNOWN = (...names: string[]) =>
  `unknown fleet-sync label${names.length === 1 ? "" : "s"} ${names.join(", ")}; the platform declares fleet-sync:all and fleet-sync:public`;

describe("readDirective", () => {
  test("the roster is the two labels the overlay declares", () => {
    expect([...FLEET_SYNC_LABELS]).toEqual([
      ["fleet-sync:all", "all"],
      ["fleet-sync:public", "public"],
    ]);
  });

  test.each<{ reason: string; labels: string[]; expected: Directive }>([
    { reason: "no labels", labels: [], expected: NONE },
    { reason: "labels of other kinds", labels: ["bug", "merge-when-green"], expected: NONE },
    { reason: "the public label", labels: ["fleet-sync:public"], expected: PUBLIC },
    {
      reason: "the all label beside another kind",
      labels: ["fleet-sync:all", "bug"],
      expected: ALL,
    },
    {
      reason: "case folds like GitHub's label names",
      labels: ["Fleet-Sync:Public"],
      expected: PUBLIC,
    },
    {
      reason: "two scopes on one pull request",
      labels: ["fleet-sync:all", "fleet-sync:public"],
      expected: { kind: "error", error: TWO_SCOPES },
    },
    {
      reason: "a fleet-sync label the platform does not declare",
      labels: ["fleet-sync:private"],
      expected: { kind: "error", error: UNKNOWN("fleet-sync:private") },
    },
    {
      reason: "an unknown label beside a known one is still refused",
      labels: ["fleet-sync:public", "fleet-sync:acme/a"],
      expected: { kind: "error", error: UNKNOWN("fleet-sync:acme/a") },
    },
    {
      reason: "a label that merely starts like the keyword is not a scope",
      labels: ["fleet-syncing"],
      expected: NONE,
    },
  ])("$reason", ({ labels, expected }) => {
    expect(readDirective(labels)).toEqual(expected);
  });
});

describe("main", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/fleet_sync_marker.ts");
  const root = temp.dir("fleet-sync-marker-");

  function git(cwd: string, args: string[]): string {
    const proc = boundedSpawnSync([
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@x.test",
      ...args,
    ]);
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
    return proc.stdout.trimEnd();
  }

  // main's history, one commit per squash merge or direct push: the fixture
  // every clone below is taken from. The leg's checkout sees the build branch
  // as refs/remotes/origin/build, so each scenario is a clone of a bare origin
  // carrying (or lacking) a build branch stamped at one commit.
  const source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  function commit(message: string): string {
    const file = join(root, `msg-${Bun.hash(message).toString(16)}.txt`);
    writeFileSync(file, message);
    git(source, ["commit", "-q", "--allow-empty", "-F", file]);
    return git(source, ["rev-parse", "HEAD"]);
  }

  // The stub answers each commit's pull request lookup from a file; a commit
  // without one answers `[]` (a direct push).
  const pulls = join(root, "pulls");
  mkdirSync(pulls);
  const gh = argvStub(root, "gh", [
    'path="$2"; sha="${path#repos/*/commits/}"; sha="${sha%/pulls}"',
    `if [ -f "${pulls}/$sha.json" ]; then cat "${pulls}/$sha.json"; else printf '[]'; fi`,
  ]);
  type Pull = { number: number; merge_commit_sha: string | null; labels: { name: string }[] };
  const labeled = (number: number, sha: string | null, ...names: string[]): Pull => ({
    number,
    merge_commit_sha: sha,
    labels: names.map((name) => ({ name })),
  });
  function squash(title: string, answer: (sha: string) => Pull[]): string {
    const sha = commit(title);
    writeFileSync(join(pulls, `${sha}.json`), JSON.stringify(answer(sha)));
    return sha;
  }

  const seed = commit("seed");
  const publicA = squash("feat: a (#40)", (sha) => [labeled(40, sha, "fleet-sync:public")]);
  const unlabeled = squash("feat: b (#41)", (sha) => [labeled(41, sha, "bug")]);
  const direct = commit("chore: a direct push\n\nNo pull request produced this commit.");
  const whole = squash("feat: c (#42)", (sha) => [labeled(42, sha, "bug", "fleet-sync:all")]);
  const twoScopes = squash("feat: d (#43)", (sha) => [
    labeled(43, sha, "fleet-sync:public", "fleet-sync:all"),
  ]);
  const unknown = squash("feat: e (#44)", (sha) => [labeled(44, sha, "fleet-sync:private")]);
  const publicB = squash("feat: f (#45)", (sha) => [labeled(45, sha, "Fleet-Sync:Public")]);
  const twoPulls = squash("feat: reopened after a closed attempt (#47)", (sha) => [
    labeled(46, "0123456789abcdef0123456789abcdef01234567", "fleet-sync:all"),
    labeled(47, sha, "fleet-sync:public"),
  ]);
  const ambiguous = squash("feat: two merges claim it (#49)", (sha) => [
    labeled(48, sha, "fleet-sync:public"),
    labeled(49, sha),
  ]);
  // The retired body grammar on a direct push's message: the old reader armed on it.
  const legacy = commit(
    "feat: the old opt-in\n\n[fleet-sync: public]\n\n## How\n\nThe thing ships.",
  );

  /** A clone whose origin carries main plus, when `stamp` is given, a
   *  build branch of one orphan commit stamped like publish.ts stamps. */
  function cloneWithBuild(name: string, stamp: string | null): string {
    const bare = join(root, `${name}.git`);
    git(root, ["clone", "-q", "--bare", source, bare]);
    if (stamp !== null) {
      const scratch = join(root, `${name}-build`);
      git(root, ["clone", "-q", bare, scratch]);
      git(scratch, ["checkout", "-q", "--orphan", "build"]);
      writeFileSync(join(scratch, "tree.txt"), "0\n");
      git(scratch, ["add", "-A"]);
      git(scratch, [
        "commit",
        "-q",
        "-m",
        `build\n\n${commitStampWrite("https://x.test", "o/r", stamp)}\nrun: https://x.test/run`,
      ]);
      git(scratch, ["push", "-q", "origin", "build"]);
    }
    const clone = join(root, name);
    git(root, ["clone", "-q", bare, clone]);
    return clone;
  }

  const unpublished = cloneWithBuild("unpublished", null);
  const publishedSeed = cloneWithBuild("published-seed", seed);
  const publishedDirect = cloneWithBuild("published-direct", direct);

  function run(
    cwd: string,
    sha: string,
    before: string,
    extra: Record<string, string> = {},
  ): BoundedSpawnResult & { output: string } {
    const outputFile = join(root, `out-${Bun.hash(cwd + sha + before).toString(16)}.txt`);
    writeFileSync(outputFile, "");
    const proc = boundedSpawnSync(["bun", script], {
      cwd,
      env: {
        ...process.env,
        PATH: `${gh.bin}:${process.env.PATH}`,
        GH_TOKEN: "t",
        GITHUB_REPOSITORY: "o/r",
        SOURCE_SHA: sha,
        BEFORE_SHA: before,
        GITHUB_OUTPUT: outputFile,
        ...extra,
      },
    });
    return { ...proc, output: readFileSync(outputFile, "utf-8") };
  }
  const lookup = (sha: string) => ["gh", "api", `repos/o/r/commits/${sha}/pulls`];

  const short = (sha: string) => sha.slice(0, 12);
  const lines = (...notices: string[]) => notices.map((text) => `${text}\n`).join("");
  const fallback = (sha: string, before: string) =>
    `::notice::no build stamp older than ${short(sha)} exists (nothing published before this run); reading from the fallback base, ${short(before)}`;
  const noLabel = (base: string, sha: string) =>
    `::notice::${short(base)}..${short(sha)} carries no fleet-sync label; the fleet picks it up on the weekly sync`;
  const label = (sha: string, scope: string) =>
    `::notice::fleet-sync label on ${short(sha)}: ${scope}`;
  const syncing = (base: string, sha: string, scope: string) =>
    `::notice::${short(base)}..${short(sha)} opted in: syncing ${scope} now`;
  const older = (sha: string, error: string) =>
    `::warning::${short(sha)}: ${error}; the commit contributes nothing to this range, and only the judged commit's labels fail this leg`;

  test("the coalescing case: three merges within a minute, only the first opted in, and only the last one's CI run survived", () => {
    // The stamped base covers every commit since the last publish, so the
    // surviving run carries the first merge's label.
    const stamped = run(publishedSeed, direct, unlabeled);
    expect(stamped).toEqual({
      exitCode: 0,
      output: "armed=true\nrepos=public\n",
      stdout: lines(label(publicA, "public"), syncing(seed, direct, "public")),
      stderr: "",
    });
    // The control, the single-commit read: the same run against an origin
    // with no build branch reads the surviving push alone and arms nothing.
    const pushOnly = run(unpublished, direct, unlabeled);
    expect(pushOnly).toEqual({
      exitCode: 0,
      output: "armed=false\n",
      stdout: lines(fallback(direct, unlabeled), noLabel(unlabeled, direct)),
      stderr: "",
    });
  });

  test("a range unions its labels: all wins over public, and an older commit's refused labels warn without poisoning the range", () => {
    // A malformed OLDER commit is a warning: a docs-only commit leaves the
    // build stamp in place, so failing here would poison every later range.
    const result = run(
      publishedDirect,
      publicB,
      git(publishedDirect, ["rev-parse", `${publicB}~1`]),
    );
    expect(result).toEqual({
      exitCode: 0,
      output: "armed=true\nrepos=all\n",
      stdout: lines(
        label(whole, "all"),
        older(twoScopes, TWO_SCOPES),
        older(unknown, UNKNOWN("fleet-sync:private")),
        label(publicB, "public"),
        syncing(direct, publicB, "all"),
      ),
      stderr: "",
    });
  });

  test.each([
    {
      reason: "a pull request with the public label arms public",
      sha: publicA,
      exitCode: 0,
      output: "armed=true\nrepos=public\n",
      stdout: (base: string, sha: string) =>
        lines(fallback(sha, base), label(sha, "public"), syncing(base, sha, "public")),
    },
    {
      reason: "a pull request with the all label arms the whole fleet",
      sha: whole,
      exitCode: 0,
      output: "armed=true\nrepos=all\n",
      stdout: (base: string, sha: string) =>
        lines(fallback(sha, base), label(sha, "all"), syncing(base, sha, "all")),
    },
    {
      reason: "a pull request without a fleet-sync label arms nothing",
      sha: unlabeled,
      exitCode: 0,
      output: "armed=false\n",
      stdout: (base: string, sha: string) => lines(fallback(sha, base), noLabel(base, sha)),
    },
    {
      reason: "a direct push has no pull request and arms nothing",
      sha: direct,
      exitCode: 0,
      output: "armed=false\n",
      stdout: (base: string, sha: string) => lines(fallback(sha, base), noLabel(base, sha)),
    },
    {
      reason: "the retired body grammar on a direct push's message arms nothing",
      sha: legacy,
      exitCode: 0,
      output: "armed=false\n",
      stdout: (base: string, sha: string) => lines(fallback(sha, base), noLabel(base, sha)),
    },
    {
      reason: "two pull requests list the commit: the one it is the merge of wins",
      sha: twoPulls,
      exitCode: 0,
      output: "armed=true\nrepos=public\n",
      stdout: (base: string, sha: string) =>
        lines(fallback(sha, base), label(sha, "public"), syncing(base, sha, "public")),
    },
    {
      reason: "two pull requests claim the commit as their merge: refused, nothing armed",
      sha: ambiguous,
      exitCode: 1,
      output: "",
      stdout: (base: string, sha: string) =>
        lines(
          fallback(sha, base),
          `::error::${short(sha)}: repos/o/r/commits/${sha}/pulls: 2 pull requests claim this commit as their merge (#48, #49); refusing to pick one`,
        ),
    },
    {
      reason: "two scopes on the judged commit's pull request: red leg, nothing armed",
      sha: twoScopes,
      exitCode: 1,
      output: "",
      stdout: (base: string, sha: string) =>
        lines(fallback(sha, base), `::error::${short(sha)}: ${TWO_SCOPES}`),
    },
    {
      reason: "an undeclared fleet-sync label on the judged commit's pull request: red leg",
      sha: unknown,
      exitCode: 1,
      output: "",
      stdout: (base: string, sha: string) =>
        lines(fallback(sha, base), `::error::${short(sha)}: ${UNKNOWN("fleet-sync:private")}`),
    },
  ])("a one-commit push without a build stamp, $reason", ({ sha, exitCode, output, stdout }) => {
    const before = git(unpublished, ["rev-parse", `${sha}~1`]);
    const seen = gh.calls().length;
    const result = run(unpublished, sha, before);
    expect(result).toEqual({ exitCode, output, stdout: stdout(before, sha), stderr: "" });
    expect(gh.calls().slice(seen)).toEqual([lookup(sha)]);
  });

  test("a failed pull request lookup is red for the whole range, never a quiet armed=false", () => {
    // The stamped range is publicA then unlabeled; the first lookup fails and names its commit.
    const seen = gh.calls().length;
    const result = run(publishedSeed, unlabeled, publicA, { STUB_EXIT: "22" });
    expect(result).toEqual({
      exitCode: 1,
      output: "",
      stdout: `::error::${short(publicA)}: repos/o/r/commits/${publicA}/pulls could not be read (gh api exit 22)\n`,
      stderr: "",
    });
    expect(gh.calls().slice(seen)).toEqual([lookup(publicA)]);
  });

  test("a truncated judged sha is refused with no output line", () => {
    const result = run(unpublished, unlabeled.slice(0, 12), seed);
    expect(result).toEqual({
      exitCode: 1,
      output: "",
      stdout: `::error::SOURCE_SHA is not a full commit sha (got '${short(unlabeled)}')\n`,
      stderr: "",
    });
  });
});
