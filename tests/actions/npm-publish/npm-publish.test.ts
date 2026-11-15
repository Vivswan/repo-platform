// What the npm-publish action decides rests on facts that live outside it: how npm orders pre-release identifiers, which
// flags switch off npm's own downgrade guard, versions already published under the same scheme, and a registry that
// answers a failed write in prose. None of these fail on their own when the code drifts from them, so they are pinned
// here. Every record and commit is synthetic.

import { expect, test } from "bun:test";
import {
  type Channel,
  nextNeedsRelease,
  nextVersion,
  type Package,
  parsePackage,
  planPublish,
  publishPackage,
  type RegistryRecord,
  type Tools,
  tagBehind,
  type Verdict,
  verdictOf,
} from "../../../actions/npm-publish/npm-publish.ts";
import type { RunResult } from "../../../actions/shared/action_runtime.ts";

const PKG: Package = { name: "@example/widget", version: "1.2.0" };
const SHA = "0123456089abcdef0123456789abcdef01234567";
const COMMITTED = String(Date.UTC(2026, 10, 14, 23, 30) / 1000);
const MINTED = "1.2.1-main.42.20261114.g0123456";

const ok = (stdout = ""): RunResult => ({ exit: { kind: "exited", code: 0 }, stdout, stderr: "" });
const failed = (stderr: string): RunResult => ({
  exit: { kind: "exited", code: 1 },
  stdout: "",
  stderr,
});

function record(versions: string[], tags: Record<string, string> = {}): RegistryRecord {
  return {
    "versions": Object.fromEntries(versions.map((version) => [version, {}])),
    "dist-tags": tags,
  };
}

// A package may already carry versions of this scheme, so a version this action mints must sort among them: the count
// compares as a number, the release on disk sits below, and any next release sits above, whatever its bump.
test.each<{ reason: string; base: string; count: number; sha: string; minted: string }>([
  {
    reason: "the next patch, then main, the count, the UTC date, and the short sha",
    base: "1.2.0",
    count: 42,
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    minted: "1.2.1-main.42.20261114.gabcdef0",
  },
  {
    reason: "an all-digit short sha keeps its leading zero behind the g",
    base: "0.9.9",
    count: 7,
    sha: SHA,
    minted: "0.9.10-main.7.20261114.g0123456",
  },
])("the next version: $reason", ({ base, count, sha, minted }) => {
  const version = nextVersion(base, { count, date: "20261114", sha });
  const later = nextVersion(base, { count: count + 100, date: "20261114", sha });
  const [major, minor, patch] = base.split(".").map(Number);
  expect({
    version,
    aboveItsBase: Bun.semver.order(version, base),
    belowTheNextPatch: Bun.semver.order(version, `${major}.${minor}.${patch + 1}`),
    belowALaterCommit: Bun.semver.order(version, later),
  }).toEqual({ version: minted, aboveItsBase: 1, belowTheNextPatch: -1, belowALaterCommit: -1 });
});

const SKIP_BEHIND = (next: string): Verdict => ({
  action: "skip",
  reason: `next names ${next}, which is not below this commit's ${MINTED}: next never moves back`,
});

// Each row is a registry state a run has met or will meet; the registry gives `next` no ordering guard of its own, and
// a wrong verdict here publishes green.
test.each<{
  reason: string;
  channel: Channel;
  version: string;
  held: RegistryRecord;
  verdict: Verdict;
}>([
  {
    reason: "a rerun, the version already published",
    channel: "next",
    version: MINTED,
    held: record(["1.2.0", MINTED], { latest: "1.2.0", next: MINTED }),
    verdict: { action: "skip", reason: `${MINTED} is already on the registry (a rerun)` },
  },
  {
    reason: "a rerun of a release",
    channel: "latest",
    version: "1.2.0",
    held: record(["1.2.0"], { latest: "1.2.0" }),
    verdict: { action: "skip", reason: "1.2.0 is already on the registry (a rerun)" },
  },
  {
    reason: "a rerun of a release whose publish left latest behind stays red",
    channel: "latest",
    version: "1.2.0",
    held: record(["1.1.0", "1.2.0"], { latest: "1.1.0" }),
    verdict: {
      action: "fail",
      reason: "1.2.0 is on the registry, but latest names 1.1.0, which is behind it",
    },
  },
  {
    reason: "next behind this commit, an earlier commit's publish",
    channel: "next",
    version: MINTED,
    held: record(["1.2.0", "1.2.1-main.5.20261101.gaaaaaaa"], {
      latest: "1.2.0",
      next: "1.2.1-main.5.20261101.gaaaaaaa",
    }),
    verdict: { action: "publish" },
  },
  {
    reason: "next ahead of this commit, a later commit's run took the lane first",
    channel: "next",
    version: MINTED,
    held: record(["1.2.0", "1.2.1-main.43.20261114.gbbbbbbb"], {
      latest: "1.2.0",
      next: "1.2.1-main.43.20261114.gbbbbbbb",
    }),
    verdict: SKIP_BEHIND("1.2.1-main.43.20261114.gbbbbbbb"),
  },
  {
    reason: "no next tag yet, the package's first pre-release",
    channel: "next",
    version: MINTED,
    held: record(["1.2.0"], { latest: "1.2.0" }),
    verdict: { action: "publish" },
  },
  {
    reason: "the first next after a release, where next sits below latest and is not repaired",
    channel: "next",
    version: MINTED,
    held: record(["1.1.0", "1.1.1-main.30.20261020.gccccccc", "1.2.0"], {
      latest: "1.2.0",
      next: "1.1.1-main.30.20261020.gccccccc",
    }),
    verdict: { action: "publish" },
  },
  {
    reason: "the first next after a release moved next to itself",
    channel: "next",
    version: MINTED,
    held: record(["1.2.0"], { latest: "1.2.0", next: "1.2.0" }),
    verdict: { action: "publish" },
  },
  {
    reason: "the package.json on main behind a released version",
    channel: "next",
    version: MINTED,
    held: record(["1.2.0", "1.2.1", "1.10.0"], { latest: "1.10.0" }),
    verdict: {
      action: "fail",
      reason: `${MINTED} is not above the released 1.10.0: the package.json on main is behind the registry`,
    },
  },
  {
    reason: "a release below one already published, whatever npm's configuration says of the tag",
    channel: "latest",
    version: "1.2.0",
    held: record(["1.3.0"], { latest: "1.3.0" }),
    verdict: {
      action: "fail",
      reason: "1.2.0 is not above the released 1.3.0: a release never moves latest back",
    },
  },
  {
    reason: "a release above every one published",
    channel: "latest",
    version: "1.2.0",
    held: record(["1.1.0", "1.2.0-main.40.20261110.gddddddd"], { latest: "1.1.0" }),
    verdict: { action: "publish" },
  },
])("the verdict: $reason", ({ channel, version, held, verdict }) => {
  expect(verdictOf(channel, version, held)).toEqual(verdict);
});

// After a publish the registry is the only witness of where a dist-tag ended: npm reports the upload, not the tag, and a
// publisher outside the lane can have moved it.
test.each<{
  reason: string;
  channel: Channel;
  version: string;
  tags: Record<string, string>;
  behind: string | null;
}>([
  {
    reason: "next names this version",
    channel: "next",
    version: MINTED,
    tags: { next: MINTED },
    behind: null,
  },
  {
    reason: "next names a later commit's version",
    channel: "next",
    version: MINTED,
    tags: { next: "1.2.1-main.43.20261114.gbbbbbbb" },
    behind: null,
  },
  {
    reason: "next still names an earlier version",
    channel: "next",
    version: MINTED,
    tags: { next: "1.2.1-main.5.20261101.gaaaaaaa" },
    behind: `${MINTED} is on the registry, but next names 1.2.1-main.5.20261101.gaaaaaaa, which is behind it`,
  },
  {
    reason: "the version went up under another tag and next names nothing",
    channel: "next",
    version: MINTED,
    tags: { latest: MINTED },
    behind: `${MINTED} is on the registry, but next names nothing, which is behind it`,
  },
  {
    reason: "latest names this release",
    channel: "latest",
    version: "1.2.0",
    tags: { latest: "1.2.0" },
    behind: null,
  },
  {
    reason: "latest still names the release before",
    channel: "latest",
    version: "1.2.0",
    tags: { latest: "1.1.0" },
    behind: "1.2.0 is on the registry, but latest names 1.1.0, which is behind it",
  },
])("the tag after a publish: $reason", ({ channel, version, tags, behind }) => {
  expect(tagBehind(channel, version, record([version], tags))).toBe(behind);
});

// `next` is never older than `latest` and never moves back: a pre-release of the release itself sorts below it, and
// one of the patch after sorts above.
test.each<{ reason: string; next: string | undefined; moves: boolean }>([
  { reason: "no next tag", next: undefined, moves: true },
  {
    reason: "next on a pre-release of this release",
    next: "1.2.0-main.40.20261110.gddddddd",
    moves: true,
  },
  { reason: "next on this release", next: "1.2.0", moves: false },
  { reason: "next on a pre-release after this release", next: MINTED, moves: false },
])("a release moves next to itself: $reason", ({ next, moves }) => {
  const tags: Record<string, string> = { latest: "1.2.0" };
  if (next !== undefined) tags.next = next;

  expect(nextNeedsRelease("1.2.0", record(["1.2.0"], tags))).toBe(moves);
});

// npm publishes neither of these as the channels mean them: `private` never, and a publishConfig.tag in place of the
// channel's, which on latest also disarms npm's guard.
test.each<{ reason: string; manifest: object; outcome: Package | string }>([
  {
    reason: "a publishable manifest",
    manifest: { name: "@example/widget", version: "1.2.0", scripts: { build: "tsc" } },
    outcome: PKG,
  },
  {
    reason: "private: true",
    manifest: { name: "widget", version: "1.2.0", private: true },
    outcome: "the package is private: true, which npm never publishes",
  },
  {
    reason: "a publishConfig.tag",
    manifest: { name: "widget", version: "1.2.0", publishConfig: { tag: "latest" } },
    outcome: "publishConfig.tag is set: the channel decides the dist-tag, so remove it",
  },
])("the manifest: $reason", ({ manifest, outcome }) => {
  let read: Package | string;
  try {
    read = parsePackage(JSON.stringify(manifest));
  } catch (cause) {
    read = (cause as Error).message;
  }
  expect(read).toEqual(outcome);
});

/** A log line as the recorder saw it: core's method, then the message. */
type Line = ["info" | "notice", string];

interface Run {
  /** What the phase returned, or the message it threw. */
  outcome: unknown;

  /** The git and npm commands, in order. */
  commands: string[];

  /** The records the run consumed, of those the registry was given. */
  reads: number;

  /** Whether the run read the last record again at least twice: it polled, where one confirming read would not. */
  waitedOut: boolean;

  /** What the run logged. */
  lines: Line[];
}

/** What the fake npm and checkout answer; every npm command succeeds unless named here. */
interface Answers {
  /** What `npm publish` answers. */
  publish?: RunResult;

  /** What `npm dist-tag` answers. */
  distTag?: RunResult;

  /** Whether the checkout is shallow. */
  shallow?: boolean;

  /** The confirmation bound: generous unless the row waits it out, so load alone cannot end a wait that would succeed. */
  boundMs?: number;
}

/** One phase against a fake checkout, npm, and registry: `records` answers the reads in order, its last entry from then on. */
async function runWith(
  phase: (tools: Tools) => Promise<unknown>,
  records: RegistryRecord[],
  answers: Answers = {},
): Promise<Run> {
  const commands: string[] = [];
  const lines: Line[] = [];
  const git: Record<string, string> = {
    "git rev-parse --is-shallow-repository": String(answers.shallow ?? false),
    "git rev-list --count --first-parent HEAD": "42",
    "git show -s --format=%ct HEAD": COMMITTED,
    "git rev-parse HEAD": SHA,
  };
  let reads = 0;
  const tools: Tools = {
    run: (command, options) => {
      if (options.cwd !== "/work/pkg") throw new Error(`ran outside the package: ${options.cwd}`);

      // The pinned npm runs as `node <cli>`; the recorder names it npm.
      const spoken = command[0] === "node" ? ["npm", ...command.slice(2)] : command;
      const line = spoken.join(" ");
      commands.push(line);
      if (line in git) return ok(`${git[line]}\n`);

      if (line.startsWith("npm publish")) return answers.publish ?? ok();

      if (line.startsWith("npm dist-tag ")) return answers.distTag ?? ok();

      if (line.startsWith("npm version ")) return ok();

      throw new Error(`unexpected command: ${line}`);
    },
    readRecord: (name) => {
      if (name !== PKG.name) throw new Error(`read another package: ${name}`);

      const held = records[Math.min(reads, records.length - 1)];
      reads += 1;
      return Promise.resolve(held);
    },
    confirm: { everyMs: 1, boundMs: answers.boundMs ?? 60_000 },
    log: {
      info: (message) => lines.push(["info", message]),
      notice: (message) => lines.push(["notice", String(message)]),
    },
  };
  let outcome: unknown;
  try {
    outcome = await phase(tools);
  } catch (cause) {
    outcome = (cause as Error).message;
  }

  return {
    outcome,
    commands,
    reads: Math.min(reads, records.length),
    waitedOut: reads >= records.length + 2,
    lines,
  };
}

const plan = (
  channel: Channel,
  tag: string,
  records: RegistryRecord[],
  answers?: Answers,
  pkg = PKG,
) =>
  runWith(
    (tools) => planPublish(pkg, { channel, tag, directory: "/work/pkg" }, tools),
    records,
    answers,
  );

const publish = (
  channel: Channel,
  version: string,
  records: RegistryRecord[],
  answers?: Answers,
  onDisk = version,
) =>
  runWith(
    (tools) =>
      publishPackage(
        { name: PKG.name, version: onDisk },
        { channel, version, directory: "/work/pkg" },
        tools,
      ),
    records,
    answers,
  );

const POSITION = [
  "git rev-parse --is-shallow-repository",
  "git rev-list --count --first-parent HEAD",
  "git show -s --format=%ct HEAD",
  "git rev-parse HEAD",
];
const STAMP = `npm version ${MINTED} --no-git-tag-version --ignore-scripts --no-workspaces-update`;
const MOVE_NEXT = "npm dist-tag add @example/widget@1.2.0 next";
const EARLIER = "1.1.1-main.30.20261020.gccccccc";
const BEFORE = record(["1.2.0"], { latest: "1.2.0", next: "1.2.0" });
const AFTER = record(["1.2.0", MINTED], { latest: "1.2.0", next: MINTED });
const UNRELEASED = record(["1.1.0", EARLIER], { latest: "1.1.0", next: EARLIER });
const RELEASED = record(["1.1.0", EARLIER, "1.2.0"], { latest: "1.2.0", next: EARLIER });
const NEXT_MOVED = record(["1.1.0", EARLIER, "1.2.0"], { latest: "1.2.0", next: "1.2.0" });
const E403 = "npm notice package: @example/widget\nnpm error code E403\nnpm error 403 Forbidden";

// The stamp's two extra flags are npm's contract: without them `npm version` runs the package's version scripts and
// updates its workspace, both before the build hook has installed anything.
// The plan runs before the repository's build, so what it leaves is the build's input: the version in package.json on
// next, and a verdict that keeps the build from running for nothing. The count and the UTC date are what place the
// version among those already published.
test.each<{ reason: string; run: () => Promise<Run>; expected: Run }>([
  {
    reason: "next: mints from the checkout and stamps the version the build will carry",
    run: () => plan("next", "", [BEFORE]),
    expected: {
      outcome: { version: MINTED, publish: true },
      commands: [...POSITION, STAMP],
      reads: 1,
      waitedOut: false,
      lines: [],
    },
  },
  {
    reason: "next: a later commit holds the tag, so nothing is stamped or built",
    run: () => plan("next", "", [record(["1.2.0"], { next: "1.2.1-main.43.20261114.gbbbbbbb" })]),
    expected: {
      outcome: { version: MINTED, publish: false },
      commands: POSITION,
      reads: 1,
      waitedOut: false,
      lines: [
        [
          "notice",
          `@example/widget: nothing to publish, next names 1.2.1-main.43.20261114.gbbbbbbb, which is not below this commit's ${MINTED}: next never moves back`,
        ],
      ],
    },
  },
  {
    reason: "latest: the release on disk, left as release-please wrote it",
    run: () => plan("latest", "v1.2.0", [UNRELEASED]),
    expected: {
      outcome: { version: "1.2.0", publish: true },
      commands: [],
      reads: 1,
      waitedOut: false,
      lines: [],
    },
  },
  {
    reason: "latest: a rerun plans no build",
    run: () => plan("latest", "v1.2.0", [RELEASED]),
    expected: {
      outcome: { version: "1.2.0", publish: false },
      commands: [],
      reads: 1,
      waitedOut: false,
      lines: [
        [
          "notice",
          "@example/widget: nothing to publish, 1.2.0 is already on the registry (a rerun)",
        ],
      ],
    },
  },
  {
    reason: "latest: a tag release-please cut for another version reads nothing",
    run: () => plan("latest", "v11.2.0", [UNRELEASED]),
    expected: {
      outcome:
        "the release tag 'v11.2.0' does not end with v1.2.0: release-please did not bump this package.json",
      commands: [],
      reads: 0,
      waitedOut: false,
      lines: [],
    },
  },
  {
    reason: "a shallow checkout: the count would stop at its boundary, so nothing is minted",
    run: () => plan("next", "", [BEFORE], { shallow: true }),
    expected: {
      outcome: "the checkout is shallow: the next version counts main's commits (fetch-depth: 0)",
      commands: POSITION.slice(0, 1),
      reads: 0,
      waitedOut: false,
      lines: [],
    },
  },
  {
    reason: "a pre-release on disk would be minted into a second pre-release",
    run: () => plan("next", "", [BEFORE], {}, { name: PKG.name, version: "1.2.0-rc.1" }),
    expected: {
      outcome: "the version on disk, 1.2.0-rc.1, must be a plain release X.Y.Z",
      commands: [],
      reads: 0,
      waitedOut: false,
      lines: [],
    },
  },
])("the plan: $reason", async ({ run, expected }) => {
  expect(await run()).toEqual(expected);
});

// The commands are npm's contract, not the code's: `--tag latest`, `--force`, or `--provenance` on the release publish
// each change what npm itself refuses, and a `next` publish without its tag would move `latest`.
// The outcomes are the registry's: its answer to a failed write is prose, so the record alone says whether it landed,
// and a run that ends before the record shows it hands the lane's next holder a stale read.
test.each<{ reason: string; run: () => Promise<Run>; expected: Run }>([
  {
    reason: "next: publishes under the next tag and waits for the record",
    run: () => publish("next", MINTED, [BEFORE, BEFORE, BEFORE, AFTER]),
    expected: {
      outcome: { version: MINTED, published: true },
      commands: ["npm publish --tag next"],
      reads: 4,
      waitedOut: false,
      lines: [],
    },
  },
  {
    reason: "next: a crossed run published this version since the plan",
    run: () => publish("next", MINTED, [AFTER]),
    expected: {
      outcome: { version: MINTED, published: false },
      commands: [],
      reads: 1,
      waitedOut: false,
      lines: [
        [
          "notice",
          `@example/widget: not published, ${MINTED} is already on the registry (a rerun)`,
        ],
      ],
    },
  },
  {
    reason: "latest: a bare npm publish, then next moves to the release",
    run: () => publish("latest", "1.2.0", [UNRELEASED, RELEASED, NEXT_MOVED]),
    expected: {
      outcome: { version: "1.2.0", published: true },
      commands: ["npm publish", MOVE_NEXT],
      reads: 3,
      waitedOut: false,
      lines: [],
    },
  },
  {
    reason: "latest: a rerun after a failed tag write publishes nothing and still moves next",
    run: () => publish("latest", "1.2.0", [RELEASED, NEXT_MOVED]),
    expected: {
      outcome: { version: "1.2.0", published: false },
      commands: [MOVE_NEXT],
      reads: 2,
      waitedOut: false,
      lines: [
        ["notice", "@example/widget: not published, 1.2.0 is already on the registry (a rerun)"],
      ],
    },
  },
  {
    reason: "latest: a rerun with next already past the release writes nothing",
    run: () =>
      publish("latest", "1.2.0", [record(["1.2.0", MINTED], { latest: "1.2.0", next: MINTED })]),
    expected: {
      outcome: { version: "1.2.0", published: false },
      commands: [],
      reads: 1,
      waitedOut: false,
      lines: [
        ["notice", "@example/widget: not published, 1.2.0 is already on the registry (a rerun)"],
        ["notice", `@example/widget: next names ${MINTED}, not below 1.2.0; left there`],
      ],
    },
  },
  {
    reason: "latest: a tag write the record never shows fails, naming the publisher's switch",
    run: () => publish("latest", "1.2.0", [RELEASED], { distTag: failed(E403), boundMs: 100 }),
    expected: {
      outcome: [
        "next was not moved to 1.2.0: npm error code E403",
        'Check the package\'s trusted publisher on npmjs.com: it must allow "npm dist-tag", which is off by default.',
        "Then re-run the job: the release is published, and only the tag is left to move.",
      ].join("\n"),
      commands: [MOVE_NEXT],
      reads: 1,
      waitedOut: true,
      lines: [
        ["notice", "@example/widget: not published, 1.2.0 is already on the registry (a rerun)"],
        ["info", E403],
      ],
    },
  },
  {
    reason: "a failed publish whose version is on the record was published",
    run: () => publish("next", MINTED, [BEFORE, AFTER], { publish: failed(E403) }),
    expected: {
      outcome: { version: MINTED, published: true },
      commands: ["npm publish --tag next"],
      reads: 2,
      waitedOut: false,
      lines: [
        ["info", E403],
        [
          "notice",
          `npm publish failed (npm error code E403), yet @example/widget@${MINTED} is on the registry`,
        ],
      ],
    },
  },
  {
    reason: "a failed publish the record never shows fails, after the whole wait",
    run: () => publish("next", MINTED, [BEFORE], { publish: failed(E403), boundMs: 100 }),
    expected: {
      outcome: [
        `npm publish failed and @example/widget@${MINTED} is not on the registry: npm error code E403`,
        "Check the package's trusted publisher on npmjs.com:",
        "  its workflow file is ci.yml",
        '  it allows "npm publish"',
        "  its repository is this one, and the package is the one named here",
      ].join("\n"),
      commands: ["npm publish --tag next"],
      reads: 1,
      waitedOut: true,
      lines: [["info", E403]],
    },
  },
  {
    reason: "a publish npm reports and the record never shows fails: a dry run uploads nothing",
    run: () => publish("next", MINTED, [BEFORE], { boundMs: 100 }),
    expected: {
      outcome: `npm reported @example/widget@${MINTED} published, but the registry did not show it within 0.1 s: re-run the job`,
      commands: ["npm publish --tag next"],
      reads: 1,
      waitedOut: true,
      lines: [],
    },
  },
  {
    reason: "a publish that landed with next still on an earlier version fails",
    run: () =>
      publish("next", MINTED, [
        BEFORE,
        record(["1.2.0", MINTED], { latest: "1.2.0", next: "1.2.0" }),
      ]),
    expected: {
      outcome: `${MINTED} is on the registry, but next names 1.2.0, which is behind it`,
      commands: ["npm publish --tag next"],
      reads: 2,
      waitedOut: false,
      lines: [],
    },
  },
  {
    reason: "a build hook that rewrote the version publishes nothing",
    run: () => publish("next", MINTED, [BEFORE], {}, "1.2.0"),
    expected: {
      outcome: `package.json is at 1.2.0, not the planned ${MINTED}: the build hook must leave the version alone`,
      commands: [],
      reads: 0,
      waitedOut: false,
      lines: [],
    },
  },
])("the publish: $reason", async ({ run, expected }) => {
  expect(await run()).toEqual(expected);
});
