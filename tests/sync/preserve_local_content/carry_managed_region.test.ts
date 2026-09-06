// carryManagedRegion: the pure carry that rebuilds one split file from a
// fresh render and its previous copy (sides restored, appendix, or throw).

import { describe, expect, test } from "bun:test";
import { carryManagedRegion } from "../../../.github/scripts/sync/preserve_local_content.ts";
import {
  AGENTS_MARKERS,
  agentsRender,
  agentsTarget,
  B,
  contributingRender,
  contributingTarget,
  E,
  gitignoreManagedNew,
  gitignoreRender,
  HB,
  HE,
  htmlAppendixCarry,
  OLD_GUIDANCE,
  OLD_LOCAL_BEGIN,
  OLD_SENTINEL,
  type SplitSpec,
} from "./fixtures";

const asEntry = (spec: SplitSpec) =>
  ({ path: spec.path, grammar: "managed-region", begin: spec.begin, end: spec.end }) as const;

const headOf = (spec: SplitSpec) => ({ path: spec.path, begin: spec.begin, end: spec.end });

describe("carryManagedRegion", () => {
  test("unchanged managed region keeps the target byte-identical (both sides)", () => {
    const target = `above notes\n${contributingRender}\n## Local dev setup\n\nrepo tail\n`;
    const carry = carryManagedRegion(
      contributingRender,
      target,
      asEntry({ path: "CONTRIBUTING.md", begin: B, end: E }),
      headOf({ path: "CONTRIBUTING.md", begin: B, end: E }),
    );
    expect(carry).toEqual({ kind: "sides-restored", content: target });
  });

  test("diverged managed region restores the target's sides around the fresh render", () => {
    const carry = carryManagedRegion(
      contributingRender,
      contributingTarget,
      asEntry({ path: "CONTRIBUTING.md", begin: B, end: E }),
      undefined,
    );
    expect(carry).toEqual({
      kind: "sides-restored",
      content: `${contributingRender}\n## Local dev setup\n\nrun the local thing\n`,
    });
  });

  test("content ABOVE the region round-trips (the both-sides capability)", () => {
    const target = `repo-owned preamble\n\n${B}\nold managed\n${E}\nrepo tail\n`;
    const render = `${B}\nnew managed\n${E}\n`;
    const carry = carryManagedRegion(render, target, asEntry(AGENTS_MARKERS), undefined);
    expect(carry).toEqual({
      kind: "sides-restored",
      content: `repo-owned preamble\n\n${B}\nnew managed\n${E}\nrepo tail\n`,
    });
  });

  test("identical target keeps the render", () => {
    expect(
      carryManagedRegion(
        contributingRender,
        contributingRender,
        asEntry({ path: "CONTRIBUTING.md", begin: B, end: E }),
        undefined,
      ),
    ).toBeNull();
  });

  test("a target with empty sides delivers exactly the render", () => {
    const target = `${B}\nold managed\n${E}\n`;
    expect(carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined)).toBeNull();
  });

  test("a whitespace-only side is carried, not silently dropped", () => {
    // The sides are byte-owned by the repository: even blanks outside the
    // region ride through rather than vanish without a disposition.
    const target = `${B}\nold managed\n${E}\n\n`;
    expect(carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined)).toEqual({
      kind: "sides-restored",
      content: `${agentsRender}\n`,
    });
  });

  test("an UNUSABLE HEAD manifest forces the appendix even when the copy splits at the new markers", () => {
    // The misattribution hazard: an old-shaped copy whose repo-owned tail
    // happens to carry one clean current marker pair would split
    // "honestly" at the new markers - and hand the repo-owned bytes
    // between them to the managed discard. With HEAD's declarations
    // unusable, no split may be guessed: keep BOTH, every byte reviewable.
    const target = `old managed top\n${OLD_SENTINEL}\ntail intro\n${B}\nREPO-OWNED SECRET\n${E}\ntail outro\n`;
    const carry = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), "unusable");
    expect(carry?.kind).toBe("appendix");
    expect(carry?.content).toContain("REPO-OWNED SECRET");
    // Contrast: with a USABLE manifest that simply lacks the declaration,
    // the same copy splits at the new markers (an ownership flip's carry).
    const flipped = carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined);
    expect(flipped?.kind).toBe("sides-restored");
  });

  test("a marker-shaped line the repo owns is NEVER stripped", () => {
    // Any spelling in repo-owned space is the repository's bytes, kept
    // byte-identical on every sync, forever.
    const target = `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n/repo-local-cache/\n\n${HB}\n*.old\n${HE}\n`;
    const carry = carryManagedRegion(
      gitignoreRender,
      target,
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      headOf({ path: ".gitignore", begin: HB, end: HE }),
    );
    expect(carry).toEqual({
      kind: "sides-restored",
      content: `${OLD_LOCAL_BEGIN}\n${OLD_GUIDANCE}\n/repo-local-cache/\n\n${gitignoreManagedNew}`,
    });
  });

  test.each([
    {
      reason: "a marker-less copy, HEAD's manifest usable but not declaring the path",
      previous: "# AGENTS.md\n\nold managed guidance\n\n## Project docs\n\nrepo-local notes\n",
      headDecl: undefined,
    },
    {
      // A one-marker-shaped copy (whose manifest headSplitEntries
      // refuses) has no trustworthy split - loud, manual review, zero
      // repo-owned bytes lost.
      reason: "a one-marker copy under an unusable HEAD manifest",
      previous: `# AGENTS.md\n\nold managed guidance\n\n${OLD_SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`,
      headDecl: "unusable" as const,
    },
  ])(
    "an unsplittable previous copy is kept whole below a marked appendix: $reason",
    ({ previous, headDecl }) => {
      expect(carryManagedRegion(agentsRender, previous, asEntry(AGENTS_MARKERS), headDecl)).toEqual(
        {
          kind: "appendix",
          content: htmlAppendixCarry(agentsRender, previous),
        },
      );
    },
  );

  test("a blank previous copy has nothing to preserve and keeps the render", () => {
    expect(carryManagedRegion(agentsRender, "\n\n", asEntry(AGENTS_MARKERS), undefined)).toBeNull();
  });

  test("a render without a clean region throws (manifest and render disagree)", () => {
    expect(() =>
      carryManagedRegion("no markers here\n", agentsTarget, asEntry(AGENTS_MARKERS), undefined),
    ).toThrow("manifest and render disagree");
  });

  test.each([
    {
      reason: "a second BEGIN/END pair (any slice would guess which region is managed)",
      target: `${B}\nfirst\n${E}\n${B}\nsecond\n${E}\n`,
    },
    {
      reason: "BEGIN text buried mid-line counts as a duplicate (substring semantics)",
      target: `mention: ${B}\n${B}\nold\n${E}\nrepo tail\n`,
    },
    {
      reason: "END text only mid-line: no END marker line closes the region",
      target: `${B}\nold managed\nmention: ${E} mid-line\n`,
    },
  ])(
    "a copy without exactly one whole-line marker pair takes the appendix, every marker occurrence neutralized: $reason",
    ({ target }) => {
      // Exactly-once whole-line markers or appendix - and the delivered
      // file keeps exactly ONE occurrence of each marker (the render's),
      // or the validator's exactly-once rule rejects the recovery output
      // with advice pointing away from the real cause.
      expect(carryManagedRegion(agentsRender, target, asEntry(AGENTS_MARKERS), undefined)).toEqual({
        kind: "appendix",
        content: htmlAppendixCarry(agentsRender, target),
      });
    },
  );

  test("hash-marker appendixes use hash comments, not an HTML comment", () => {
    const carry = carryManagedRegion(
      gitignoreRender,
      "legacy patterns, no markers\n",
      asEntry({ path: ".gitignore", begin: HB, end: HE }),
      undefined,
    );
    expect(carry?.kind).toBe("appendix");
    expect(carry?.content).toContain("# repo-platform:recovery-appendix");
    expect(carry?.content).not.toContain("<!--");
  });

  test("a second recovery over an appendix result is stable (single appendix)", () => {
    const legacy = "old copy without markers\nrepo-local notes\n";
    const first = carryManagedRegion(agentsRender, legacy, asEntry(AGENTS_MARKERS), undefined);
    expect(first?.kind).toBe("appendix");
    const second = carryManagedRegion(
      agentsRender,
      first?.content ?? "",
      asEntry(AGENTS_MARKERS),
      undefined,
    );
    expect(second?.kind).toBe("sides-restored");
    expect(second?.content).toBe(first?.content ?? "");
    expect(second?.content.split("repo-platform:recovery-appendix").length).toBe(2);
  });

  test("markers whose neutralized forms collide fail loudly, never invalidly", () => {
    // "# A-B" dash-joins to "#-A-B" - recreating the BEGIN marker after
    // BEGIN was already neutralized: the postcondition must refuse to
    // deliver a file the validator's exactly-once rule rejects. The
    // declaration schema forbids such pairs; this is the backstop for
    // hostile manifest text.
    const entry = { path: "x", grammar: "managed-region", begin: "#-A-B", end: "# A-B" } as const;
    const render = "#-A-B\nmanaged\n# A-B\n";
    expect(() =>
      carryManagedRegion(render, "no clean split, has # A-B text\n", entry, undefined),
    ).toThrow("collide under neutralization");
  });

  test.each([
    {
      reason: "a stray trailing space",
      render: agentsRender,
      target: `${B} \nold managed\n${E}\nrepo tail\n`,
      expected: `${agentsRender}repo tail\n`,
    },
    {
      reason: "a leading indent",
      render: agentsRender,
      target: `above\n  ${B}\nold\n${E}\nrepo tail\n`,
      expected: `above\n${agentsRender}repo tail\n`,
    },
    {
      reason: "CRLF line endings (the sides keep their bytes)",
      render: `${B}\r\ndocs\r\n${E}\r\n`,
      target: `${B}\r\nold\r\n${E}\r\nrepo tail\r\n`,
      expected: `${B}\r\ndocs\r\n${E}\r\nrepo tail\r\n`,
    },
  ])(
    "a marker line anchors the split under trim semantics: $reason",
    ({ render, target, expected }) => {
      // isMarkerLine trims; the stamper and the validator already counted
      // the decorated line as the marker line, and the SUBSTRING
      // exactly-once rule still holds, so the region slices cleanly.
      expect(carryManagedRegion(render, target, asEntry(AGENTS_MARKERS), undefined)).toEqual({
        kind: "sides-restored",
        content: expected,
      });
    },
  );

  test("a render whose END line has no trailing newline still joins cleanly", () => {
    const render = `${B}\ndocs\n${E}`;
    const target = `${B}\nold\n${E}\nrepo tail\n`;
    expect(carryManagedRegion(render, target, asEntry(AGENTS_MARKERS), undefined)).toEqual({
      kind: "sides-restored",
      content: `${B}\ndocs\n${E}\nrepo tail\n`,
    });
  });
});
