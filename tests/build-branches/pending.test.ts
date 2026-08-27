// pending.ts: the build-during-CI handoff's race rules. The pending refs
// are keyed by source sha (disjoint across concurrent pushes) and the
// publisher enforces newest-green-wins - a stale build must never
// overwrite a newer published tree, while replays, damaged stamps, and
// diverged histories stay their own machinery's business.

import { describe, expect, test } from "bun:test";
import {
  PENDING_REF_PREFIX,
  pendingRefFor,
  refSuperseded,
  staleReason,
} from "../../.github/scripts/build-branches/pending.ts";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

/** main history: OLD is an ancestor of NEW, nothing else relates. */
const mainHistory = (ancestor: string, descendant: string): boolean =>
  ancestor === OLD && descendant === NEW;

describe("pendingRefFor", () => {
  test("keys the ref by the full source sha", () => {
    expect(pendingRefFor(OLD)).toBe(`${PENDING_REF_PREFIX}${OLD}`);
  });

  test("rejects anything but a full sha - a ref name is a filesystem-ish input", () => {
    for (const bad of ["", "main", "a".repeat(39), `${"a".repeat(39)}/`]) {
      expect(() => pendingRefFor(bad)).toThrow("full commit sha");
    }
  });
});

describe("staleReason (newest-green wins)", () => {
  test("a stale build - the tip already ships a DESCENDANT - is refused with the rule", () => {
    const reason = staleReason(OLD, NEW, mainHistory);
    expect(reason).toContain("newest-green wins");
    expect(reason).toContain(NEW.slice(0, 12));
    expect(reason).toContain(OLD.slice(0, 12));
  });

  test("a newer build over an older tip proceeds", () => {
    expect(staleReason(NEW, OLD, mainHistory)).toBe("");
  });

  test("an equal source proceeds - the no-change/re-stamp path owns replays", () => {
    expect(staleReason(NEW, NEW, mainHistory)).toBe("");
  });

  test("an empty tip stamp proceeds - the re-stamp machinery owns damaged stamps", () => {
    expect(staleReason(NEW, "", mainHistory)).toBe("");
  });

  test("a diverged tip source proceeds - a history rewrite is provenance's report, not staleness", () => {
    expect(staleReason("c".repeat(40), "d".repeat(40), mainHistory)).toBe("");
  });
});

describe("refSuperseded (the per-source ref sweep)", () => {
  // The rule behind publish.ts's sweep of refs/build-pending/ and
  // refs/build-meta/template-noop/: an inverted own-ref policy would
  // either strand every consumed pending ref or delete the no-op verdict
  // the sync's waiter is about to verify.
  test("an ancestor source's ref is superseded under either policy", () => {
    expect(refSuperseded(OLD, NEW, "consume", mainHistory)).toBe(true);
    expect(refSuperseded(OLD, NEW, "keep", mainHistory)).toBe(true);
  });

  test("the candidate's own ref follows the policy: pendings consumed, markers kept", () => {
    expect(refSuperseded(NEW, NEW, "consume", mainHistory)).toBe(true);
    expect(refSuperseded(NEW, NEW, "keep", mainHistory)).toBe(false);
  });

  test("a NEWER source's ref never sweeps - its own publisher still needs it", () => {
    expect(refSuperseded(NEW, OLD, "consume", mainHistory)).toBe(false);
    expect(refSuperseded(NEW, OLD, "keep", mainHistory)).toBe(false);
  });

  test("an unresolvable or diverged source stays - isAncestor answers false there", () => {
    expect(refSuperseded("c".repeat(40), NEW, "consume", mainHistory)).toBe(false);
  });
});
