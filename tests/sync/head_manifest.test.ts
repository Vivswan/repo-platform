import { describe, expect, test } from "bun:test";
import {
  headSplitEntries,
  managedPart,
  repoOwnedSides,
  repoOwnedText,
} from "../../.github/scripts/sync/head_manifest.ts";

const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
const E = "<!-- END REPO-PLATFORM MANAGED -->";
const HB = "# BEGIN REPO-PLATFORM MANAGED";
const HE = "# END REPO-PLATFORM MANAGED";
const OLD_SENTINEL = "<!-- repo-platform:local-section -->";
const OLD_LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
const OLD_LOCAL_END = "# END REPOSITORY LOCAL";

function manifestOf(files: Record<string, unknown>): string {
  return JSON.stringify({ files });
}

describe("headSplitEntries", () => {
  test("reads current-vintage managed-region entries", () => {
    const text = manifestOf({
      "AGENTS.md": { class: "split", grammar: "managed-region", begin: B, end: E, hash: null },
      "README.md": { class: "starter" },
    });
    expect([...headSplitEntries(text, "m").values()]).toEqual([
      { vintage: "managed-region", path: "AGENTS.md", begin: B, end: E },
    ]);
  });

  test("reads the RETIRED tail-marker vintage (the transition shim)", () => {
    const text = manifestOf({
      "AGENTS.md": {
        class: "split",
        grammar: "tail-marker",
        marker: OLD_SENTINEL,
        managed: "above",
        hash: null,
      },
    });
    expect(headSplitEntries(text, "m").get("AGENTS.md")).toEqual({
      vintage: "tail-marker",
      path: "AGENTS.md",
      marker: OLD_SENTINEL,
    });
  });

  test("reads the RETIRED four-marker bounded-region vintage (the transition shim)", () => {
    const text = manifestOf({
      ".gitignore": {
        class: "split",
        grammar: "bounded-region",
        marker: HB,
        managed: "below",
        managed_end: HE,
        local_begin: OLD_LOCAL_BEGIN,
        local_end: OLD_LOCAL_END,
        hash: null,
      },
    });
    expect(headSplitEntries(text, "m").get(".gitignore")).toEqual({
      vintage: "bounded-region",
      path: ".gitignore",
      managed_begin: HB,
    });
  });

  test("a split entry with NO grammar is refused loudly (pre-grammar manifest)", () => {
    const text = manifestOf({
      "AGENTS.md": { class: "split", marker: OLD_SENTINEL, managed: "above", hash: null },
    });
    expect(() => headSplitEntries(text, "m")).toThrow("predates the stamped split grammar");
    expect(() => headSplitEntries(text, "m")).toThrow("recover=recopy");
  });

  test("a grammar this sync does not read is refused, never skipped", () => {
    // Neither current nor a retired vintage the transition converts: a
    // guessed boundary could overwrite repo-owned bytes, so the reader
    // refuses and every caller fails closed.
    const text = manifestOf({
      "AGENTS.md": { class: "split", grammar: "prefix", marker: OLD_SENTINEL, hash: null },
    });
    expect(() => headSplitEntries(text, "m")).toThrow('split grammar "prefix"');
    expect(() => headSplitEntries(text, "m")).toThrow("refusing to guess");
  });

  test("an unknown ownership class is refused (damage could hide a split)", () => {
    const text = manifestOf({ "AGENTS.md": { class: "spllt" } });
    expect(() => headSplitEntries(text, "m")).toThrow("no ownership class this sync knows");
  });

  test("duplicate keys, non-JSON, and files-less shapes are refused", () => {
    expect(() => headSplitEntries("not json", "m")).toThrow("does not parse as JSON");
    expect(() => headSplitEntries("{}", "m")).toThrow("no top-level 'files' mapping");
    expect(() => headSplitEntries('{"files": []}', "m")).toThrow("no top-level 'files' mapping");
    expect(() =>
      headSplitEntries('{"files": {"a": {"class": "split", "class": "starter"}}}', "m"),
    ).toThrow("declares the same key twice");
  });

  test("a non-ASCII or missing marker string is refused per vintage", () => {
    expect(() =>
      headSplitEntries(
        manifestOf({ a: { class: "split", grammar: "managed-region", begin: B } }),
        "m",
      ),
    ).toThrow("printable-ASCII 'end' marker");
    expect(() =>
      headSplitEntries(
        manifestOf({
          a: { class: "split", grammar: "tail-marker", marker: "# § marker", managed: "above" },
        }),
        "m",
      ),
    ).toThrow("printable-ASCII 'marker' marker");
  });

  test("a retired declaration with a flipped or missing side is refused, never re-read", () => {
    // The old emitters always wrote tail-marker as managed-above and
    // bounded-region as managed-below; a contradicting (or absent) side is
    // damage, and reading it by the grammar's usual side could hand a
    // repo-owned area to the managed discard.
    for (const managed of ["below", undefined]) {
      expect(() =>
        headSplitEntries(
          manifestOf({ a: { class: "split", grammar: "tail-marker", marker: "# m", managed } }),
          "m",
        ),
      ).toThrow("managed side other than 'above'");
    }
    expect(() =>
      headSplitEntries(
        manifestOf({
          a: {
            class: "split",
            grammar: "bounded-region",
            marker: HB,
            managed: "above",
            managed_end: HE,
            local_begin: OLD_LOCAL_BEGIN,
            local_end: OLD_LOCAL_END,
          },
        }),
        "m",
      ),
    ).toThrow("managed side other than 'below'");
  });

  test("a retired bounded-region entry missing its region strings is refused", () => {
    // Only the BEGIN line locates the repo-owned side, but a partial
    // retired shape is damage, not a vintage.
    expect(() =>
      headSplitEntries(
        manifestOf({
          a: { class: "split", grammar: "bounded-region", marker: HB, managed: "below" },
        }),
        "m",
      ),
    ).toThrow("printable-ASCII 'managed_end' marker");
  });
});

describe("repoOwnedSides / managedPart / repoOwnedText", () => {
  test("managed-region: both sides, the region as the managed part", () => {
    const decl = { vintage: "managed-region", path: "a", begin: B, end: E } as const;
    const content = `above\n${B}\nmanaged\n${E}\nbelow\n`;
    expect(repoOwnedSides(content, decl)).toEqual({
      above: "above\n",
      below: "below\n",
      extraMarkers: false,
    });
    expect(managedPart(content, decl)).toBe(`${B}\nmanaged\n${E}\n`);
    expect(repoOwnedText(content, decl)).toBe("above\n\nbelow\n");
  });

  test("managed-region: a copy that does not split cleanly reads as null", () => {
    const decl = { vintage: "managed-region", path: "a", begin: B, end: E } as const;
    expect(repoOwnedSides("no markers\n", decl)).toBeNull();
    expect(repoOwnedSides(`${B}\ntwice\n${E}\n${B}\n${E}\n`, decl)).toBeNull();
    expect(managedPart("no markers\n", decl)).toBeNull();
  });

  test("tail-marker: empty above, everything after the FIRST marker below", () => {
    const decl = { vintage: "tail-marker", path: "a", marker: OLD_SENTINEL } as const;
    const content = `managed top\n${OLD_SENTINEL}\nrepo tail\n`;
    expect(repoOwnedSides(content, decl)).toEqual({
      above: "",
      below: "repo tail\n",
      extraMarkers: false,
    });
    expect(managedPart(content, decl)).toBe(`managed top\n${OLD_SENTINEL}\n`);
    expect(repoOwnedText(content, decl)).toBe("repo tail\n");
  });

  test("tail-marker: duplicate markers keep everything after the first and flag it", () => {
    const decl = { vintage: "tail-marker", path: "a", marker: OLD_SENTINEL } as const;
    const content = `${OLD_SENTINEL}\nbetween\n${OLD_SENTINEL}\nafter\n`;
    expect(repoOwnedSides(content, decl)).toEqual({
      above: "",
      below: `between\n${OLD_SENTINEL}\nafter\n`,
      extraMarkers: true,
    });
  });

  test("tail-marker: a copy without the marker reads as null", () => {
    const decl = { vintage: "tail-marker", path: "a", marker: OLD_SENTINEL } as const;
    expect(repoOwnedSides("no marker here\n", decl)).toBeNull();
  });

  test("bounded-region: everything above the BEGIN line (old LOCAL markers included)", () => {
    const decl = { vintage: "bounded-region", path: "a", managed_begin: HB } as const;
    const content = `${OLD_LOCAL_BEGIN}\n/cache/\n${OLD_LOCAL_END}\n\n${HB}\n*.old\n${HE}\n`;
    expect(repoOwnedSides(content, decl)).toEqual({
      above: `${OLD_LOCAL_BEGIN}\n/cache/\n${OLD_LOCAL_END}\n\n`,
      below: "",
      extraMarkers: false,
    });
    expect(managedPart(content, decl)).toBe(`${HB}\n*.old\n${HE}\n`);
  });

  test("bounded-region: a duplicated BEGIN reads as null (splitting would guess)", () => {
    const decl = { vintage: "bounded-region", path: "a", managed_begin: HB } as const;
    expect(repoOwnedSides(`${HB}\nfirst\n${HB}\nsecond\n`, decl)).toBeNull();
    // A mid-line mention counts too (substring semantics).
    expect(repoOwnedSides(`mention ${HB}\n${HB}\nmanaged\n`, decl)).toBeNull();
  });
});
