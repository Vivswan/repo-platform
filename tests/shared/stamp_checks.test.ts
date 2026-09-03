// The stamp-health battery (shared/stamp_checks.ts): checks 1+2 of the
// build-tip trust chain, shared by the sync's provenance verifier (a
// reason fails the sync) and publish.ts's no-change skip guard (a reason
// means publish a recovery commit instead of skipping). Pure logic with
// injected git answers; the two consumers' wiring is proven in their own
// suites.

import { describe, expect, test } from "bun:test";
import { stampUnhealthyReason } from "../../.github/scripts/shared/stamp_checks.ts";

const MAIN = "main-ref";
const SOURCE = "a".repeat(40);
const NEWER = "b".repeat(40);
const OLDER = "c".repeat(40);
const OFFMAIN = "d".repeat(40);

const STAMP = (sha: string) => `source: https://github.com/o/r/commit/${sha}`;

/** Injected git: `resolvable` answers resolveCommit, `ancestry` ("A:B"
 * pairs) answers isAncestor. */
function git(resolvable: string[], ancestry: string[]) {
  return {
    resolveCommit: (revspec: string) => (resolvable.includes(revspec) ? revspec : ""),
    isAncestor: (a: string, d: string) => ancestry.includes(`${a}:${d}`),
  };
}

describe("stampUnhealthyReason", () => {
  test("healthy: a resolvable on-main stamp with no newer stamped ancestor", () => {
    const reason = stampUnhealthyReason({
      sourceSha: SOURCE,
      history: `${STAMP(SOURCE)}\n${STAMP(OLDER)}`,
      mainRef: MAIN,
      git: git([SOURCE, OLDER], [`${SOURCE}:${MAIN}`, `${OLDER}:${MAIN}`, `${OLDER}:${SOURCE}`]),
    });
    expect(reason).toBe("");
  });

  test("an unstamped tip is unhealthy", () => {
    const reason = stampUnhealthyReason({
      sourceSha: "",
      history: "",
      mainRef: MAIN,
      git: git([], []),
    });
    expect(reason).toBe("the tip carries no parseable source stamp");
  });

  test("an unresolvable stamped source is unhealthy", () => {
    const reason = stampUnhealthyReason({
      sourceSha: SOURCE,
      history: STAMP(SOURCE),
      mainRef: MAIN,
      git: git([], []),
    });
    expect(reason).toBe(`stamped source ${SOURCE.slice(0, 12)} is unreachable`);
  });

  test("an off-main stamped source is unhealthy (check 1)", () => {
    const reason = stampUnhealthyReason({
      sourceSha: OFFMAIN,
      history: STAMP(OFFMAIN),
      mainRef: MAIN,
      git: git([OFFMAIN], []),
    });
    expect(reason).toBe(`stamped source ${OFFMAIN.slice(0, 12)} is not on main's history`);
  });

  test("a newer on-main stamp in the ancestry is unhealthy (check 2, the rollback)", () => {
    const reason = stampUnhealthyReason({
      sourceSha: OLDER,
      history: `${STAMP(OLDER)}\n${STAMP(NEWER)}`,
      mainRef: MAIN,
      git: git([OLDER, NEWER], [`${OLDER}:${MAIN}`, `${NEWER}:${MAIN}`, `${OLDER}:${NEWER}`]),
    });
    expect(reason).toBe(
      `the history already stamped the newer source ${NEWER.slice(0, 12)} - the tip replays an older build`,
    );
  });

  test("planted stamps that are unresolvable or off-main never order the rollback walk", () => {
    // An attacker planting a stamp naming an off-main DESCENDANT of the
    // tip's source (or a garbage sha) must not poison the branch against
    // every legitimate build that follows.
    const reason = stampUnhealthyReason({
      sourceSha: SOURCE,
      history: `${STAMP(SOURCE)}\n${STAMP(OFFMAIN)}\n${STAMP("9".repeat(40))}`,
      mainRef: MAIN,
      git: git([SOURCE, OFFMAIN], [`${SOURCE}:${MAIN}`, `${SOURCE}:${OFFMAIN}`]),
    });
    expect(reason).toBe("");
  });

  test("the tip's own stamp in the walk compares equal and passes", () => {
    const reason = stampUnhealthyReason({
      sourceSha: SOURCE,
      history: STAMP(SOURCE),
      mainRef: MAIN,
      git: git([SOURCE], [`${SOURCE}:${MAIN}`, `${SOURCE}:${SOURCE}`]),
    });
    expect(reason).toBe("");
  });
});
