import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { join } from "node:path";
import { groupNamespaces } from "../../.github/scripts/ci/sweep_harness_namespaces";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const SCRIPT = join(import.meta.dir, "../../.github/scripts/ci/sweep_harness_namespaces.ts");
const temp = tempDirs();
const HOST = hostname();
const IDENTITY = ["-c", "user.name=ci", "-c", "user.email=ci@localhost"];

/** A pid no process holds: a child that already exited and was reaped. */
function deadPid(): number {
  const proc = Bun.spawnSync(["true"], { stdout: "ignore", stderr: "ignore", timeout: 5_000 });
  return proc.pid;
}

interface Fixture {
  repo: string;
  livePid: number;
  deadPid: number;
  /** Every planted ref, sorted, the way for-each-ref lists them. */
  planted: string[];
}

/** A scratch bare repo holding six namespaces: one owned by this process
 * (live), one by a dead pid, one by an out-of-range pid, one by another
 * host, one with a lightweight `/run` tag, one with no `/run` tag at all. */
function plant(): Fixture {
  const repo = temp.dir("sweep-namespaces-");
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
    `pid=${livePid} host=${HOST} started=2026-09-06T09:00:00Z dir=/tmp/upgrade-path.lite`,
  ]);
  const dead = deadPid();
  const own = (name: string, pid: number, host: string) =>
    fixtureGit(repo, [
      ...IDENTITY,
      "tag",
      "-a",
      "-m",
      `pid=${pid} host=${host} started=2026-09-06T10:00:00Z dir=/tmp/upgrade-path.${name}`,
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
  own("dead1", dead, HOST);
  refs("dead1", "old", "new");
  fixtureGit(repo, ["tag", "ci-build-lite/run", commit]);
  refs("lite", "old");
  own("live1", livePid, HOST);
  refs("live1", "old", "new", "split");
  refs("noRun", "old");
  own("other", dead, "another-host.local");
  refs("other", "old");
  // Refs outside the harness's namespace family must never be touched.
  fixtureGit(repo, ["update-ref", "refs/heads/main", commit]);
  fixtureGit(repo, ["tag", "v1.0.0", commit]);
  return { repo, livePid, deadPid: dead, planted: listRefs(repo) };
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

const DEAD1 = [
  "refs/heads/ci-build-dead1",
  "refs/tags/ci-build-dead1/new",
  "refs/tags/ci-build-dead1/old",
  "refs/tags/ci-build-dead1/run",
];
const UNOWNED = [
  "refs/heads/ci-build-badpid",
  "refs/heads/ci-build-lite",
  "refs/heads/ci-build-noRun",
  "refs/tags/ci-build-badpid/old",
  "refs/tags/ci-build-badpid/run",
  "refs/tags/ci-build-lite/old",
  "refs/tags/ci-build-lite/run",
  "refs/tags/ci-build-noRun/old",
];

function expectedPlan(fixture: Fixture, mode: string, force: boolean): string[] {
  const noRecord = "killed before writing its /run tag, or a pre-owner leftover";
  const unowned = (name: string, why: string, detail: string, refs: number) =>
    force
      ? `delete  ci-build-${name}: ${why} (--force-unowned); ${refs} refs`
      : `keep    ci-build-${name}: ${why} (${detail}); ${refs} refs, --force-unowned deletes`;
  const badPid = "pid 2147483648, started 2026-09-06T10:00:00Z, dir /tmp/upgrade-path.badpid";
  return [
    `6 ci-build-* namespace(s) in ${fixture.repo} (${mode})`,
    `  ${unowned("badpid", "owner liveness unknown", badPid, 3)}`,
    `  delete  ci-build-dead1: owner dead (pid ${fixture.deadPid}, started 2026-09-06T10:00:00Z); 4 refs; dir /tmp/upgrade-path.dead1 gone`,
    `  ${unowned("lite", "no owner record", noRecord, 3)}`,
    `  refuse  ci-build-live1: owner alive (pid ${fixture.livePid}, started 2026-09-06T10:00:00Z, dir /tmp/upgrade-path.live1)`,
    `  ${unowned("noRun", "no owner record", noRecord, 2)}`,
    `  keep    ci-build-other: owned on host another-host.local (pid ${fixture.deadPid}, started 2026-09-06T10:00:00Z); sweep it from there`,
  ];
}

describe("sweep_harness_namespaces", () => {
  // Each row is one invocation and its WHOLE outcome: exit code, the
  // printed plan, and exactly which refs survive.
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
      removed: DEAD1,
      trailer: "deleted 4 refs",
    },
    {
      args: ["--execute", "--force-unowned"],
      mode: "execute",
      force: true,
      removed: [...DEAD1, ...UNOWNED],
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
});

describe("groupNamespaces", () => {
  test("groups by namespace, sorts, trusts only annotated /run tags, keeps /run last", () => {
    // Git's own listing order: heads before tags, tags alphabetical, so a
    // `/split` tag arrives AFTER `/run` and must still be deleted before it.
    const listing = [
      "refs/heads/ci-build-b\tcommit\tbuild(ci): ci-build-b/old",
      "refs/heads/main\tcommit\tfeat: x",
      "refs/tags/ci-build-a/run\tcommit\tpid=7 host=h.local started=2026-09-06T10:00:00Z dir=/tmp/x",
      "refs/tags/ci-build-b/old\tcommit\tbuild(ci): ci-build-b/old",
      "refs/tags/ci-build-b/run\ttag\tpid=7 host=h.local started=2026-09-06T10:00:00Z dir=/tmp/upgrade-path.b",
      "refs/tags/ci-build-b/split\tcommit\tbuild(ci): ci-build-b/split",
      "refs/tags/ci-build-c/run\ttag\tnot an owner record",
      "refs/tags/v1.0.0\tcommit\trelease",
      "",
    ].join("\n");
    expect(groupNamespaces(listing)).toEqual([
      { name: "ci-build-a", refs: ["refs/tags/ci-build-a/run"], owner: null },
      {
        name: "ci-build-b",
        refs: [
          "refs/heads/ci-build-b",
          "refs/tags/ci-build-b/old",
          "refs/tags/ci-build-b/split",
          "refs/tags/ci-build-b/run",
        ],
        owner: {
          pid: 7,
          host: "h.local",
          started: "2026-09-06T10:00:00Z",
          dir: "/tmp/upgrade-path.b",
        },
      },
      { name: "ci-build-c", refs: ["refs/tags/ci-build-c/run"], owner: null },
    ]);
  });
});
