import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  groupNamespaces,
  HARNESS_TAG_NAMES,
} from "../../.github/scripts/ci/sweep_harness_namespaces";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";
import { NAMESPACE_TAG_NAMES } from "./upgrade_path/fixture";

const SCRIPT = join(import.meta.dir, "../../.github/scripts/ci/sweep_harness_namespaces.ts");
const temp = tempDirs();
const HOST = hostname();
const IDENTITY = ["-c", "user.name=ci", "-c", "user.email=ci@localhost"];
const STARTED = "2026-09-06T10:00:00Z";

/** A pid no process holds: a child that already exited and was reaped. */
function deadPid(): number {
  const proc = Bun.spawnSync(["true"], { stdout: "ignore", stderr: "ignore", timeout: 5_000 });
  return proc.pid;
}

interface Fixture {
  repo: string;
  /** `dir` recorded for namespace `name`: under the fixture root, so no stray
   * directory on the machine can flip its "gone" reading. */
  dirOf: (name: string) => string;
  livePid: number;
  deadPid: number;
  /** Every planted ref, sorted, the way for-each-ref lists them. */
  planted: string[];
}

/** A scratch bare repo: six namespaces in the harness's six-character
 * token shape, one per verdict path, plus refs that only look like one. */
function plant(): Fixture {
  const root = temp.dir("sweep-namespaces-");
  const repo = join(root, "repo.git");
  const dirOf = (name: string) => join(root, `upgrade-path.${name}`);
  mkdirSync(repo);
  fixtureGit(repo, ["init", "-q", "--bare"]);
  const tree = fixtureGit(repo, ["hash-object", "-w", "-t", "tree", "/dev/null"]);
  const livePid = process.pid;
  // The commit subject is itself owner-shaped, so a lightweight `/run` tag
  // reads as a live owner unless the sweeper insists on an annotated tag.
  const commit = fixtureGit(repo, [
    ...IDENTITY,
    "commit-tree",
    tree,
    "-m",
    `pid=${livePid} host=${HOST} started=${STARTED} dir=${dirOf("lite00")}`,
  ]);
  const dead = deadPid();
  const own = (name: string, pid: number, host: string) =>
    fixtureGit(repo, [
      ...IDENTITY,
      "tag",
      "-a",
      "-m",
      `pid=${pid} host=${host} started=${STARTED} dir=${dirOf(name)}`,
      `ci-build-${name}/run`,
      commit,
    ]);
  const refs = (name: string, ...tags: string[]) => {
    fixtureGit(repo, ["update-ref", `refs/heads/ci-build-${name}`, commit]);
    for (const tag of tags) fixtureGit(repo, ["tag", `ci-build-${name}/${tag}`, commit]);
  };
  // process.kill throws ERR_INVALID_ARG_TYPE for this pid; a sweeper that
  // reads any throw as "dead" deletes the namespace.
  own("badpid", 2147483648, HOST);
  refs("badpid", "old");
  own("dead01", dead, HOST);
  refs("dead01", "old", "new");
  mkdirSync(dirOf("dead01"));
  fixtureGit(repo, ["tag", "ci-build-lite00/run", commit]);
  refs("lite00", "old");
  own("live01", livePid, HOST);
  refs("live01", "old", "new", "split");
  refs("norun0", "old");
  own("other0", dead, "another-host.local");
  refs("other0", "old");
  // Not namespaces: ordinary refs, and lookalikes with the wrong token
  // length or a tag name the harness never creates.
  fixtureGit(repo, ["update-ref", "refs/heads/main", commit]);
  fixtureGit(repo, ["tag", "v1.0.0", commit]);
  fixtureGit(repo, ["update-ref", "refs/heads/ci-build-release", commit]);
  fixtureGit(repo, ["tag", "ci-build-release/old", commit]);
  fixtureGit(repo, ["update-ref", "refs/heads/ci-build-abcdefg", commit]);
  fixtureGit(repo, ["tag", "ci-build-abcdef/extra", commit]);
  return { repo, dirOf, livePid, deadPid: dead, planted: listRefs(repo) };
}

function listRefs(repo: string): string[] {
  return fixtureGit(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
}

function sweep(repo: string, args: string[]) {
  const proc = boundedSpawnSync(["bun", SCRIPT, "--repo", repo, ...args], {
    env: fixtureGitEnv(),
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr };
}

const DEAD = [
  "refs/heads/ci-build-dead01",
  "refs/tags/ci-build-dead01/new",
  "refs/tags/ci-build-dead01/old",
  "refs/tags/ci-build-dead01/run",
];
const UNOWNED = [
  "refs/heads/ci-build-badpid",
  "refs/heads/ci-build-lite00",
  "refs/heads/ci-build-norun0",
  "refs/tags/ci-build-badpid/old",
  "refs/tags/ci-build-badpid/run",
  "refs/tags/ci-build-lite00/old",
  "refs/tags/ci-build-lite00/run",
  "refs/tags/ci-build-norun0/old",
];

function expectedPlan(f: Fixture, mode: string, force: boolean): string[] {
  const noRecord = "a pre-owner leftover, or a /run tag that is not an annotated record";
  const unowned = (name: string, why: string, detail: string, refs: number) =>
    force
      ? `delete  ci-build-${name}: ${why} (--force-unowned); ${refs} refs`
      : `keep    ci-build-${name}: ${why} (${detail}); ${refs} refs, --force-unowned deletes`;
  const badPid = `pid 2147483648, started ${STARTED}, dir ${f.dirOf("badpid")}`;
  const deadDir = `dir ${f.dirOf("dead01")} still present: rm -rf it, then git worktree prune`;
  return [
    `6 ci-build-* namespace(s) in ${f.repo} (${mode})`,
    `  ${unowned("badpid", "owner liveness unknown", badPid, 3)}`,
    `  delete  ci-build-dead01: owner dead (pid ${f.deadPid}, started ${STARTED}); 4 refs; ${deadDir}`,
    `  ${unowned("lite00", "no owner record", noRecord, 3)}`,
    `  refuse  ci-build-live01: owner alive (pid ${f.livePid}, started ${STARTED}, dir ${f.dirOf("live01")})`,
    `  ${unowned("norun0", "no owner record", noRecord, 2)}`,
    `  keep    ci-build-other0: owned on host another-host.local (pid ${f.deadPid}, started ${STARTED}); sweep it from there`,
  ];
}

describe("sweep_harness_namespaces", () => {
  // Each row is one invocation and its WHOLE outcome: exit code, the
  // printed plan, and exactly which refs survive (lookalikes always do).
  test.each<{ args: string[]; mode: string; force: boolean; removed: string[]; trailer: string }>([
    {
      args: [],
      mode: "dry run",
      force: false,
      removed: [],
      trailer: "dry run: nothing deleted; pass --execute to act",
    },
    {
      args: ["--force-unowned"],
      mode: "dry run",
      force: true,
      removed: [],
      trailer: "dry run: nothing deleted; pass --execute to act",
    },
    {
      args: ["--execute"],
      mode: "execute",
      force: false,
      removed: DEAD,
      trailer: "deleted 4 refs",
    },
    {
      args: ["--execute", "--force-unowned"],
      mode: "execute",
      force: true,
      removed: [...DEAD, ...UNOWNED],
      trailer: "deleted 12 refs",
    },
  ])("$args", ({ args, mode, force, removed, trailer }) => {
    const fixture = plant();
    const result = sweep(fixture.repo, args);
    expect(result).toEqual({
      exitCode: 0,
      stdout: `${[...expectedPlan(fixture, mode, force), trailer].join("\n")}\n`,
      stderr: "",
    });
    expect(listRefs(fixture.repo)).toEqual(fixture.planted.filter((ref) => !removed.includes(ref)));
  });

  test("an empty ref store and a bad flag", () => {
    const repo = temp.dir("sweep-namespaces-empty-");
    fixtureGit(repo, ["init", "-q", "--bare"]);
    expect(sweep(repo, [])).toEqual({
      exitCode: 0,
      stdout: `no ci-build-* namespaces in ${repo}\n`,
      stderr: "",
    });
    const bad = sweep(repo, ["--prune"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('unknown argument "--prune"');
  });

  test("the sweeper's tag list is the harness's namespace tag list", () => {
    expect([...NAMESPACE_TAG_NAMES].sort()).toEqual([...HARNESS_TAG_NAMES].sort());
  });
});

describe("groupNamespaces", () => {
  test("groups by namespace, sorts, trusts only annotated /run tags, keeps /run last", () => {
    // Git's own listing order: heads before tags, tags alphabetical, so a
    // `/split` tag arrives AFTER `/run` and must still be deleted before it.
    const listing = [
      "refs/heads/ci-build-bbbbbb\tcommit\tbuild(ci): ci-build-bbbbbb/old",
      "refs/heads/ci-build-release\tcommit\tfeat: lookalike",
      "refs/heads/main\tcommit\tfeat: x",
      "refs/tags/ci-build-aaaaaa/run\tcommit\tpid=7 host=h.local started=2026-09-06T10:00:00Z dir=/tmp/x",
      "refs/tags/ci-build-bbbbbb/extra\tcommit\tnot a harness tag",
      "refs/tags/ci-build-bbbbbb/old\tcommit\tbuild(ci): ci-build-bbbbbb/old",
      "refs/tags/ci-build-bbbbbb/run\ttag\tpid=7 host=h.local started=2026-09-06T10:00:00Z dir=/tmp/upgrade-path.b",
      "refs/tags/ci-build-bbbbbb/split\tcommit\tbuild(ci): ci-build-bbbbbb/split",
      "refs/tags/ci-build-cccccc/run\ttag\tnot an owner record",
      "refs/tags/v1.0.0\tcommit\trelease",
      "",
    ].join("\n");
    expect(groupNamespaces(listing)).toEqual([
      { name: "ci-build-aaaaaa", refs: ["refs/tags/ci-build-aaaaaa/run"], owner: null },
      {
        name: "ci-build-bbbbbb",
        refs: [
          "refs/heads/ci-build-bbbbbb",
          "refs/tags/ci-build-bbbbbb/old",
          "refs/tags/ci-build-bbbbbb/split",
          "refs/tags/ci-build-bbbbbb/run",
        ],
        owner: {
          pid: 7,
          host: "h.local",
          started: "2026-09-06T10:00:00Z",
          dir: "/tmp/upgrade-path.b",
        },
      },
      { name: "ci-build-cccccc", refs: ["refs/tags/ci-build-cccccc/run"], owner: null },
    ]);
  });
});
