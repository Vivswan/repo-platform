import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Directive,
  FLEET_SYNC_OVERLAY,
  fleetSyncLabels,
  readDirective,
} from "../../.github/scripts/post-green/fleet_sync_marker.ts";
import { loadLayer } from "../../.github/scripts/sync/writer/settings_layers.ts";
import { type BoundedSpawnResult, boundedSpawnSync } from "../shared/bounded_spawn";
import { type FakeGithubServer, type FakeRoutes, spawnFakeGithub } from "../shared/fake_github";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { parseGithubOutput } from "../shared/github_output";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const PUBLIC: Directive = { kind: "fleet-sync", scope: "public" };
const NONE: Directive = { kind: "none" };
const TWO_SCOPES = "2 fleet-sync labels (fleet-sync:all, fleet-sync:public): one scope per merge";
const UNKNOWN = (...names: string[]) =>
  `unknown fleet-sync label${names.length === 1 ? "" : "s"} ${names.join(", ")}; the platform declares fleet-sync:all and fleet-sync:public`;

test("a label is lowercased and scoped by its suffix; a label of another kind is not one", () => {
  const declared = (...names: string[]) => ({
    labels: names.map((name) => ({ name, color: "0052cc", description: "d" })),
  });
  expect([...fleetSyncLabels(declared("Fleet-Sync:All", "bug"), "overlay")]).toEqual([
    ["fleet-sync:all", "all"],
  ]);
});

describe("readDirective", () => {
  const KNOWN = fleetSyncLabels(loadLayer(FLEET_SYNC_OVERLAY).doc, "overlay");

  // The executed list below proves the plain shapes end to end.
  test.each<{ reason: string; labels: string[]; expected: Directive }>([
    { reason: "labels of other kinds", labels: ["bug", "merge-when-green"], expected: NONE },
    {
      reason: "case folds like GitHub's label names",
      labels: ["Fleet-Sync:Public"],
      expected: PUBLIC,
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
    expect(readDirective(labels, KNOWN)).toEqual(expected);
  });
});

describe("main", () => {
  const script = join(import.meta.dir, "../../.github/scripts/post-green/fleet_sync_marker.ts");
  let root: string;
  let source: string;
  let clone: string;

  function git(cwd: string, args: string[]): string {
    return fixtureGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@x.test", ...args]);
  }

  // main's history, one commit per squash merge or direct push; the leg runs in a clone of it, as
  // actions/checkout leaves one.
  function commit(message: string): string {
    const file = join(root, `msg-${Bun.hash(message).toString(16)}.txt`);
    writeFileSync(file, message);
    git(source, ["commit", "-q", "--allow-empty", "-F", file]);
    return git(source, ["rev-parse", "HEAD"]);
  }

  // Each commit's pull request lookup, filled as the history below is written; a commit without one answers `[]`
  // (a direct push). The API serves them from its own process, started once the table is whole.
  const routes: FakeRoutes = { "repos/o/r/commits/*/pulls": [{ status: 200, body: [] }] };
  let api: FakeGithubServer;
  let downApi: FakeGithubServer;
  beforeAll(async () => {
    root = temp.dir("fleet-sync-marker-");
    source = join(root, "source");
    mkdirSync(source);
    git(source, ["init", "-q", "-b", "main"]);
    writeHistory();
    clone = join(root, "clone");
    git(root, ["clone", "-q", source, clone]);
    api = await spawnFakeGithub(routes, join(root, "api.log"));
    downApi = await spawnFakeGithub(
      { "repos/o/r/commits/*/pulls": [{ status: 503 }] },
      join(root, "down-api.log"),
    );
  });
  afterAll(() => {
    api.stop();
    downApi.stop();
  });
  type Pull = { number: number; merge_commit_sha: string | null; labels: { name: string }[] };
  const labeled = (number: number, sha: string | null, ...names: string[]): Pull => ({
    number,
    merge_commit_sha: sha,
    labels: names.map((name) => ({ name })),
  });
  function squash(title: string, answer: (sha: string) => Pull[]): string {
    const sha = commit(title);
    routes[`repos/o/r/commits/${sha}/pulls`] = [{ status: 200, body: answer(sha) }];
    return sha;
  }

  let seed: string;
  let publicA: string;
  let unlabeled: string;
  let direct: string;
  let whole: string;
  let twoScopes: string;
  let unknown: string;
  let publicB: string;
  let twoPulls: string;
  let ambiguous: string;
  function writeHistory(): void {
    seed = commit("seed");
    publicA = squash("feat: a (#40)", (sha) => [labeled(40, sha, "fleet-sync:public")]);
    unlabeled = squash("feat: b (#41)", (sha) => [labeled(41, sha, "bug")]);
    direct = commit("chore: a direct push\n\nNo pull request produced this commit.");
    whole = squash("feat: c (#42)", (sha) => [labeled(42, sha, "bug", "fleet-sync:all")]);
    twoScopes = squash("feat: d (#43)", (sha) => [
      labeled(43, sha, "fleet-sync:public", "fleet-sync:all"),
    ]);
    unknown = squash("feat: e (#44)", (sha) => [labeled(44, sha, "fleet-sync:private")]);
    publicB = squash("feat: f (#45)", (sha) => [labeled(45, sha, "Fleet-Sync:Public")]);
    twoPulls = squash("feat: reopened after a closed attempt (#47)", (sha) => [
      labeled(46, "0123456789abcdef0123456789abcdef01234567", "fleet-sync:all"),
      labeled(47, sha, "fleet-sync:public"),
    ]);
    ambiguous = squash("feat: two merges claim it (#49)", (sha) => [
      labeled(48, sha, "fleet-sync:public"),
      labeled(49, sha),
    ]);
  }

  /** The latest run's name on the API, where its requests are listed; two tests may judge the same range. */
  let latestRun = "";
  let runs = 0;

  function run(
    cwd: string,
    sha: string,
    before: string,
    server: FakeGithubServer = api,
  ): BoundedSpawnResult & { output: Record<string, string> } {
    latestRun = `run-${++runs}`;
    const name = latestRun;
    const outputFile = join(root, `out-${name}.txt`);
    writeFileSync(outputFile, "");
    const proc = boundedSpawnSync(["bun", script], {
      cwd,
      env: {
        ...fixtureGitEnv(),
        GH_TOKEN: "t",
        GITHUB_API_URL: `${server.host}/${name}`,
        GITHUB_RETRY_BASE_MS: "0",
        GITHUB_REPOSITORY: "o/r",
        SOURCE_SHA: sha,
        BEFORE_SHA: before,
        GITHUB_OUTPUT: outputFile,
      },
    });
    return { ...proc, output: parseGithubOutput(readFileSync(outputFile, "utf-8")) };
  }
  const lookup = (sha: string) => `repos/o/r/commits/${sha}/pulls`;

  const short = (sha: string) => sha.slice(0, 12);
  const lines = (...notices: string[]) => notices.map((text) => `${text}\n`).join("");
  const noLabel = (base: string, sha: string) =>
    `::notice::${short(base)}..${short(sha)} carries no fleet-sync label; the fleet picks it up on the weekly sync`;
  const label = (sha: string, scope: string) =>
    `::notice::fleet-sync label on ${short(sha)}: ${scope}`;
  const syncing = (base: string, sha: string, scope: string) =>
    `::notice::${short(base)}..${short(sha)} opted in: syncing ${scope} now`;
  const older = (sha: string, error: string) =>
    `::warning::${short(sha)}: ${error}; the commit contributes nothing to this range, and only the judged commit's labels fail this leg`;

  test("the coalescing case: three merges within a minute, only the first opted in, and only the last one's CI run survived", () => {
    // The base is the commit the tag named before this run moved it, so the
    // surviving run's range carries the first merge's label.
    const fromTag = run(clone, direct, seed);
    expect(fromTag).toEqual({
      exitCode: 0,
      output: { armed: "true", repos: "public" },
      stdout: lines(label(publicA, "public"), syncing(seed, direct, "public")),
      stderr: "",
    });
    // The control, the single-commit read: the push's own before reads the
    // surviving push alone and arms nothing.
    const pushOnly = run(clone, direct, unlabeled);
    expect(pushOnly).toEqual({
      exitCode: 0,
      output: { armed: "false" },
      stdout: lines(noLabel(unlabeled, direct)),
      stderr: "",
    });
  });

  test("a range unions its labels: all wins over public, and an older commit's refused labels warn without poisoning the range", () => {
    // A malformed OLDER commit is a warning: failing here would poison every
    // range that starts below it.
    const result = run(clone, publicB, direct);
    expect(result).toEqual({
      exitCode: 0,
      output: { armed: "true", repos: "all" },
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

  test.each<{
    reason: string;
    sha: () => string;
    exitCode: number;
    output: Record<string, string>;
    stdout: (base: string, sha: string) => string;
  }>([
    {
      reason: "a pull request with the public label arms public",
      sha: () => publicA,
      exitCode: 0,
      output: { armed: "true", repos: "public" },
      stdout: (base: string, sha: string) =>
        lines(label(sha, "public"), syncing(base, sha, "public")),
    },
    {
      reason: "a pull request with the all label arms the whole fleet",
      sha: () => whole,
      exitCode: 0,
      output: { armed: "true", repos: "all" },
      stdout: (base: string, sha: string) => lines(label(sha, "all"), syncing(base, sha, "all")),
    },
    {
      reason: "a pull request without a fleet-sync label arms nothing",
      sha: () => unlabeled,
      exitCode: 0,
      output: { armed: "false" },
      stdout: (base: string, sha: string) => lines(noLabel(base, sha)),
    },
    {
      reason: "a direct push has no pull request and arms nothing",
      sha: () => direct,
      exitCode: 0,
      output: { armed: "false" },
      stdout: (base: string, sha: string) => lines(noLabel(base, sha)),
    },
    {
      reason: "two pull requests list the commit: the one it is the merge of wins",
      sha: () => twoPulls,
      exitCode: 0,
      output: { armed: "true", repos: "public" },
      stdout: (base: string, sha: string) =>
        lines(label(sha, "public"), syncing(base, sha, "public")),
    },
    {
      reason: "two pull requests claim the commit as their merge: refused, nothing armed",
      sha: () => ambiguous,
      exitCode: 1,
      output: {},
      stdout: (_base: string, sha: string) =>
        lines(
          `::error::${short(sha)}: repos/o/r/commits/${sha}/pulls: 2 pull requests claim this commit as their merge (#48, #49); refusing to pick one`,
        ),
    },
    {
      reason: "two scopes on the judged commit's pull request: red leg, nothing armed",
      sha: () => twoScopes,
      exitCode: 1,
      output: {},
      stdout: (_base: string, sha: string) => lines(`::error::${short(sha)}: ${TWO_SCOPES}`),
    },
    {
      reason: "an undeclared fleet-sync label on the judged commit's pull request: red leg",
      sha: () => unknown,
      exitCode: 1,
      output: {},
      stdout: (_base: string, sha: string) =>
        lines(`::error::${short(sha)}: ${UNKNOWN("fleet-sync:private")}`),
    },
  ])("a one-commit push, $reason", ({ sha: judged, exitCode, output, stdout }) => {
    const sha = judged();
    const before = git(clone, ["rev-parse", `${sha}~1`]);
    const result = run(clone, sha, before);
    expect(result).toEqual({ exitCode, output, stdout: stdout(before, sha), stderr: "" });
    expect(api.calls(latestRun)).toEqual([lookup(sha)]);
  });

  test("a failed pull request lookup is red for the whole range, never a quiet armed=false", () => {
    // The range is publicA then unlabeled; the first lookup fails on every attempt and names its commit.
    const result = run(clone, unlabeled, seed, downApi);
    expect(result).toEqual({
      exitCode: 1,
      output: {},
      stdout: `::error::${short(publicA)}: repos/o/r/commits/${publicA}/pulls could not be read (HTTP 503)\n`,
      stderr: "",
    });
    expect(downApi.calls(latestRun)).toEqual(Array(4).fill(lookup(publicA)));
  });
});
