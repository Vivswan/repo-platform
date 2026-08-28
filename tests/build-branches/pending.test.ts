// pending.ts: the build-during-CI handoff's race rules. The pending refs
// are keyed by source sha (disjoint across concurrent pushes) and the
// publisher enforces newest-green-wins - a stale build must never
// overwrite a newer published tree, while replays fall through to
// publish.ts's tree diff (nothing changed publishes nothing; drift
// republishes), damaged stamps are the stamp-recovery lane's business,
// and diverged histories stay the provenance machinery's.

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
  test("keys the ref by the full source sha, in the BRANCH namespace", () => {
    // The literal prefix is deliberate: only branches and tags can ever
    // be ruleset-covered, so the namespace keeps the OPTION of scoping
    // pending-ref writes to the publisher if GitHub's dialect ever allows
    // it on user repositories (pending.ts's header has the residual this
    // parks). Moving the prefix out of refs/heads/ would silently close
    // that option, so the expectation is spelled out rather than derived.
    expect(pendingRefFor(OLD)).toBe(`refs/heads/build-pending/${OLD}`);
    expect(PENDING_REF_PREFIX).toBe("refs/heads/build-pending/");
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

  test("an equal source proceeds - publish.ts's tree diff owns the replay decision", () => {
    expect(staleReason(NEW, NEW, mainHistory)).toBe("");
  });

  test("an empty tip stamp proceeds - the stamp-recovery lane owns damaged stamps", () => {
    expect(staleReason(NEW, "", mainHistory)).toBe("");
  });

  test("a diverged tip source proceeds - a history rewrite is provenance's report, not staleness", () => {
    expect(staleReason("c".repeat(40), "d".repeat(40), mainHistory)).toBe("");
  });
});

describe("refSuperseded (the pending-ref sweep)", () => {
  // The rule behind publish.ts's sweep of refs/build-pending/: a sweep
  // that spared the consumed refs would strand every promoted tree, and
  // one that ate newer sources' refs would slow their own publishers
  // onto the compose fallback.
  test("an ancestor source's ref is superseded", () => {
    expect(refSuperseded(OLD, NEW, mainHistory)).toBe(true);
  });

  test("the candidate's own ref is consumed - its tree was just promoted", () => {
    expect(refSuperseded(NEW, NEW, mainHistory)).toBe(true);
  });

  test("a NEWER source's ref never sweeps - its own publisher still needs it", () => {
    expect(refSuperseded(NEW, OLD, mainHistory)).toBe(false);
  });

  test("an unresolvable or diverged source stays - isAncestor answers false there", () => {
    expect(refSuperseded("c".repeat(40), NEW, mainHistory)).toBe(false);
  });
});
