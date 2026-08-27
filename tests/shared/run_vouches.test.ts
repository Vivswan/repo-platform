// The run-proof vouching rule (shared/run_vouches.ts): one function, two
// enforcement points (publish.ts's re-stamp check and the sync's
// verify_build_provenance.ts). Every clause is pinned here, ACCEPT and
// REJECT alike: the rule deliberately loosens strict head-sha equality
// (impossible for the workflow_run publisher, whose run carries main's
// current tip), so each guard that keeps the loosened arm honest must be
// individually unlosable.

import { describe, expect, test } from "bun:test";
import { runVouchesForSource } from "../../.github/scripts/shared/run_vouches.ts";

const SOURCE = "a".repeat(40);
const LATER = "b".repeat(40);
const MAIN = "origin/main";

// A small fake history: LATER descends from SOURCE, both on main.
function onMainHistory(options: { resolvable?: string[]; onMain?: string[] } = {}) {
  const resolvable = options.resolvable ?? [SOURCE, LATER];
  const onMain = options.onMain ?? [SOURCE, LATER];
  return {
    resolveCommit: (revspec: string) => {
      const sha = revspec.replace(/\^\{commit\}$/, "");
      return resolvable.includes(sha) ? sha : "";
    },
    isAncestor: (ancestor: string, descendant: string) => {
      if (descendant === MAIN) return onMain.includes(ancestor);
      return ancestor === SOURCE && descendant === LATER;
    },
  };
}

describe("runVouchesForSource", () => {
  test("accepts head-sha equality, even when the sha would not resolve locally", () => {
    // Equality is the direct proof and must not depend on the local
    // clone's object store.
    const { isAncestor } = onMainHistory();
    expect(
      runVouchesForSource({
        runHeadSha: SOURCE,
        sourceSha: SOURCE,
        mainRef: MAIN,
        resolveCommit: () => "",
        isAncestor,
      }),
    ).toBe(true);
  });

  test("accepts an on-main descendant run head that contains the source", () => {
    // The workflow_run publisher case: the run carries main's tip, the
    // source is an earlier main commit it descends from.
    expect(
      runVouchesForSource({
        runHeadSha: LATER,
        sourceSha: SOURCE,
        mainRef: MAIN,
        ...onMainHistory(),
      }),
    ).toBe(true);
  });

  test("rejects a run head that does not resolve locally", () => {
    expect(
      runVouchesForSource({
        runHeadSha: LATER,
        sourceSha: SOURCE,
        mainRef: MAIN,
        ...onMainHistory({ resolvable: [SOURCE] }),
      }),
    ).toBe(false);
  });

  test("rejects a run head that is not on main history", () => {
    // A forged stamp naming a run at an off-main commit (say, a branch
    // build) must not vouch for anything.
    expect(
      runVouchesForSource({
        runHeadSha: LATER,
        sourceSha: SOURCE,
        mainRef: MAIN,
        ...onMainHistory({ onMain: [SOURCE] }),
      }),
    ).toBe(false);
  });

  test("rejects a run head that does not contain the source", () => {
    // The source must be an ancestor of the run head: a run at a SIBLING
    // or EARLIER commit cannot vouch for this source.
    const history = onMainHistory();
    expect(
      runVouchesForSource({
        runHeadSha: SOURCE,
        sourceSha: LATER,
        mainRef: MAIN,
        resolveCommit: history.resolveCommit,
        isAncestor: history.isAncestor,
      }),
    ).toBe(false);
  });
});
