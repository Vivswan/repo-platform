import { describe, expect, test } from "bun:test";
import { commitRunParse, commitStampParse } from "../../.github/scripts/shared/commit_stamp.ts";
import {
  NOOP_MARKER_REF_PREFIX,
  noopClaimName,
  noopMarkerMessage,
  noopMarkerRefFor,
  noopMarkerTipParse,
} from "../../.github/scripts/shared/noop_marker.ts";

const SOURCE = "62653b669d40d3c88b6a0c713942d7e80ac4032d";
const TIP = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

describe("no-op marker", () => {
  test("the marker refs live outside refs/heads/, keyed by full source sha", () => {
    // A branch-shaped marker would pick up branch semantics (protection
    // evaluation, checkout offers); the parking namespace precedent is
    // refs/build-pending/. Per-source: disjoint refs under concurrency,
    // and the waiter fetches exactly its own source's verdict.
    expect(NOOP_MARKER_REF_PREFIX.startsWith("refs/")).toBe(true);
    expect(NOOP_MARKER_REF_PREFIX.startsWith("refs/heads/")).toBe(false);
    expect(noopMarkerRefFor(SOURCE)).toBe(`${NOOP_MARKER_REF_PREFIX}${SOURCE}`);
  });

  test("ref and claim names take only full shas", () => {
    // The values reach a git refspec and a gh api artifact match; a
    // revspec or short sha must never be encoded into either.
    expect(() => noopMarkerRefFor("main")).toThrow();
    expect(() => noopMarkerRefFor(SOURCE.slice(0, 12))).toThrow();
    expect(() => noopClaimName(SOURCE, "refs/heads/main")).toThrow();
    expect(noopClaimName(SOURCE, TIP)).toBe(`template-noop-${SOURCE}-${TIP}`);
  });

  test("write then parse round-trips all three claims", () => {
    // The waiter reads the REAL writer's message: source via the shared
    // stamp line, tip via the marker's own line, run via the shared run
    // line - one drifted shape and the marker is dead weight.
    const message = noopMarkerMessage(
      "https://github.com",
      "Vivswan/repo-platform",
      SOURCE,
      TIP,
      "https://github.com/Vivswan/repo-platform/actions/runs/8675309",
    );
    expect(commitStampParse(message)).toBe(SOURCE);
    expect(noopMarkerTipParse(message)).toBe(TIP);
    expect(commitRunParse(message)).toBe("8675309");
  });

  test("the tip line never parses as the source stamp, nor the reverse", () => {
    // The two lines share the /commit/ URL shape; only the prefix keeps a
    // marker's tip from reading as its source (which would let a forged
    // single-line message satisfy both checks with one sha).
    const message = noopMarkerMessage("https://github.com", "o/r", SOURCE, TIP, "u");
    expect(commitStampParse(message)).not.toBe(TIP);
    expect(noopMarkerTipParse(message)).not.toBe(SOURCE);
  });

  test("only a full 40-hex sha parses as the tip", () => {
    // Plain text anyone can write: a smuggled revspec would re-resolve
    // differently on every read (commit_stamp.ts's rule).
    expect(noopMarkerTipParse("tip: https://github.com/o/r/commit/main")).toBe("");
    expect(noopMarkerTipParse(`tip: https://github.com/o/r/commit/${TIP.slice(0, 12)}`)).toBe("");
    expect(noopMarkerTipParse("no tip line at all")).toBe("");
  });
});
