// pending.ts: the build-during-CI handoff's race rules. The pending refs
// are keyed by source sha (disjoint across concurrent pushes) and the
// publisher enforces newest-green-wins - a stale build must never
// overwrite a newer published tree, while replays, damaged stamps, and
// diverged histories stay their own machinery's business.

import { describe, expect, test } from "bun:test";
import {
  PENDING_REF_PREFIX,
  pendingRefFor,
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
