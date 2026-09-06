// recorded_commit.ts over a scratch platform: a build chain, a stray
// orphan, and a hex-named tag reach every arm; the negative control is the
// revspec `origin/build` the resolver exists for.

import { describe, expect, test } from "bun:test";
import {
  type CommitHistory,
  FULL_SHA_RE,
  resolveRecordedCommit,
  unusableReason,
} from "../../.github/scripts/sync/recorded_commit.ts";
import { git, ladderFixtures, rungSource } from "../shared/migration_fixtures.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const { platform } = ladderFixtures(temp);

/** Build history old -> new (tags), a stray orphan (a main-history commit
 * reads the same way: not a build commit), and a tag whose NAME is 40 hex
 * digits pointing at the old build commit. */
function scratch() {
  const dir = platform([
    { tag: "old", rungs: {} },
    { tag: "new", rungs: { "m0001_a.ts": rungSource("m0001_a") } },
  ]);
  const oldSha = git(dir, "rev-parse", "old").trim();
  const newSha = git(dir, "rev-parse", "new").trim();
  git(dir, "update-ref", "refs/remotes/origin/build", "new");
  git(dir, "checkout", "-q", "--orphan", "stray");
  git(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@x",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "stray",
  );
  const straySha = git(dir, "rev-parse", "HEAD").trim();
  const hexTag = "a".repeat(40);
  git(dir, "tag", hexTag, oldSha);
  const history: CommitHistory = {
    dir,
    buildRef: "refs/remotes/origin/build",
    deliveredSha: newSha,
  };
  return { dir, oldSha, newSha, straySha, hexTag, history };
}

describe("resolveRecordedCommit", () => {
  const s = scratch();

  test.each([
    ["the delivered build's ancestor", () => s.oldSha, { kind: "ok", sha: s.oldSha }],
    ["the delivered build itself", () => s.newSha, { kind: "ok", sha: s.newSha }],
    ["a short sha of a real build commit", () => s.oldSha.slice(0, 12), { kind: "not-a-sha" }],
    ["an upper-case full sha", () => s.oldSha.toUpperCase(), { kind: "not-a-sha" }],
    ["a 40-hex tag NAME pointing at build history", () => s.hexTag, { kind: "unresolved" }],
    ["a missing object", () => "0123456789abcdef0123456789abcdef01234567", { kind: "unresolved" }],
    ["a reachable commit outside the build history", () => s.straySha, { kind: "not-ancestor" }],
  ])("%s", (_reason, value, expected) => {
    expect(resolveRecordedCommit(value(), s.history)).toEqual(expected);
  });

  test("THE negative control: git resolves the revspec origin/build to the delivered tip, the resolver refuses it", () => {
    expect(git(s.dir, "rev-parse", "--verify", "origin/build^{commit}").trim()).toBe(s.newSha);
    expect(resolveRecordedCommit("origin/build", s.history)).toEqual({ kind: "not-a-sha" });
  });

  test("a build commit ahead of the delivered build is refused, and passes when nothing is delivered", () => {
    const behind = { ...s.history, deliveredSha: s.oldSha };
    expect(resolveRecordedCommit(s.newSha, behind)).toEqual({ kind: "ahead-of-delivered" });
    const { deliveredSha: _omitted, ...noDelivery } = s.history;
    expect(resolveRecordedCommit(s.newSha, noDelivery)).toEqual({ kind: "ok", sha: s.newSha });
  });

  test("a git failure throws instead of reading as unresolved or not-ancestor", () => {
    const empty = temp.dir("not-a-repo-");
    expect(() => resolveRecordedCommit(s.oldSha, { ...s.history, dir: empty })).toThrow(
      "git rev-parse failed",
    );
    // A real commit judged against a ref this repository does not have.
    expect(() =>
      resolveRecordedCommit(s.oldSha, { ...s.history, buildRef: "refs/remotes/origin/nope" }),
    ).toThrow("git merge-base --is-ancestor failed");
  });

  test("the shape guard shared with the runner accepts only lower-case 40-hex", () => {
    expect(FULL_SHA_RE.test(s.oldSha)).toBe(true);
    expect(FULL_SHA_RE.test(`${s.oldSha}\n`)).toBe(false);
    expect(FULL_SHA_RE.test("origin/build")).toBe(false);
  });

  test("every unusable arm names a distinct refusal that carries the shown value", () => {
    const reasons = (
      ["not-a-sha", "unresolved", "not-ancestor", "ahead-of-delivered"] as const
    ).map((kind) => unusableReason({ kind }, "SHOWN"));
    expect(new Set(reasons).size).toBe(4);
    for (const reason of reasons) expect(reason).toContain("SHOWN");
  });
});
