import { describe, expect, test } from "bun:test";
import {
  CONVERSION_RELIC_LINES,
  carriedRepoOwnedText,
  carriedSides,
  headSplitEntries,
  managedPart,
  repoOwnedSides,
  repoOwnedText,
  stripConversionRelics,
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

// The CONVERSION's one deliberate subtraction: the old bounded .gitignore
// shape left PLATFORM-AUTHORED lines sitting in what the one grammar
// calls repo-owned space - the retired marker spellings and a guidance
// line the managed region makes false. Only exact (trimmed) matches from
// the closed set go; everything the repository wrote must survive
// byte-identical.
describe("stripConversionRelics", () => {
  const GUIDANCE = "# Add repository-specific ignore patterns in this section only.";

  test("strips the retired LOCAL marker pair and the false guidance line", () => {
    const above = `${OLD_LOCAL_BEGIN}\n${GUIDANCE}\n/repo-cache/\n${OLD_LOCAL_END}\n\n`;
    expect(stripConversionRelics(above)).toEqual({
      text: "/repo-cache/\n\n",
      stripped: [OLD_LOCAL_BEGIN, GUIDANCE, OLD_LOCAL_END],
      blanksCollapsed: 0,
    });
  });

  test("strips the retired tail-marker sentinels, both comment syntaxes", () => {
    expect(stripConversionRelics(`${OLD_SENTINEL}\nrepo tail\n`)).toEqual({
      text: "repo tail\n",
      stripped: [OLD_SENTINEL],
      blanksCollapsed: 0,
    });
    expect(stripConversionRelics("# repo-platform:local-section\nrepo tail\n")).toEqual({
      text: "repo tail\n",
      stripped: ["# repo-platform:local-section"],
      blanksCollapsed: 0,
    });
  });

  test("a repo-authored LOOKALIKE of the guidance line survives byte-identical", () => {
    // The relic set is exact full lines, never patterns: a line the
    // repository wrote that merely resembles the retired guidance is the
    // repository's content and must ride through untouched.
    const lookalikes = [
      "# Add repository-specific ignore patterns here please\n",
      "# Add repository-specific ignore patterns in this section only\n",
      "## Add repository-specific ignore patterns in this section only.\n",
      `${GUIDANCE} And keep them tidy.\n`,
      "# BEGIN REPOSITORY LOCAL PATTERNS\n",
      "not-a-comment # BEGIN REPOSITORY LOCAL\n",
    ];
    for (const line of lookalikes) {
      expect(stripConversionRelics(line)).toEqual({
        text: line,
        stripped: [],
        blanksCollapsed: 0,
      });
    }
  });

  test("a side with no relic line is returned byte-identical (blank lines included)", () => {
    const side = "/repo-cache/\n\n\nsecret.env\n";
    expect(stripConversionRelics(side)).toEqual({ text: side, stripped: [], blanksCollapsed: 0 });
    // Non-UTF-8 bytes ride through the latin1 pipeline untouched.
    const latin1 = "caf\xe9-cache/\n";
    expect(stripConversionRelics(latin1)).toEqual({
      text: latin1,
      stripped: [],
      blanksCollapsed: 0,
    });
  });

  test("a marker line with stray surrounding whitespace still counts as the relic", () => {
    expect(stripConversionRelics(`  ${OLD_LOCAL_END}  \nrepo line\n`)).toEqual({
      text: "repo line\n",
      stripped: [`  ${OLD_LOCAL_END}  `],
      blanksCollapsed: 0,
    });
  });

  test("BLANK HYGIENE: the strip never opens a side with a blank or doubles one", () => {
    // Leading blank: the removed relic was the first line. The dropped
    // blank is COUNTED - the carry note states it, so the whole difference
    // between the previous side and the carried one is accounted for.
    expect(stripConversionRelics(`${OLD_LOCAL_BEGIN}\n\n/repo-cache/\n`)).toEqual({
      text: "/repo-cache/\n",
      stripped: [OLD_LOCAL_BEGIN],
      blanksCollapsed: 1,
    });
    // Doubled blank: a blank sat on each side of the removed relic.
    expect(stripConversionRelics(`/repo-cache/\n\n${OLD_LOCAL_END}\n\nsecret.env\n`)).toEqual({
      text: "/repo-cache/\n\nsecret.env\n",
      stripped: [OLD_LOCAL_END],
      blanksCollapsed: 1,
    });
    // A blank the strip never disturbed is NOT collapsed (conservative)
    // and nothing is counted for it.
    expect(stripConversionRelics(`${OLD_LOCAL_END}\na\n\n\nb\n`)).toEqual({
      text: "a\n\n\nb\n",
      stripped: [OLD_LOCAL_END],
      blanksCollapsed: 0,
    });
  });

  test("a side that was ONLY relics and blanks collapses to empty", () => {
    // The whole old LOCAL block was platform boilerplate: nothing
    // repo-owned is left, so the converted file gets no leading blank -
    // and the blank that went with it is counted, never silent.
    const above = `${OLD_LOCAL_BEGIN}\n${GUIDANCE}\n${OLD_LOCAL_END}\n\n`;
    expect(stripConversionRelics(above)).toEqual({
      text: "",
      stripped: [OLD_LOCAL_BEGIN, GUIDANCE, OLD_LOCAL_END],
      blanksCollapsed: 1,
    });
  });

  test("IDEMPOTENT: stripping an already-stripped side changes nothing", () => {
    const above = `${OLD_LOCAL_BEGIN}\n${GUIDANCE}\n/repo-cache/\n${OLD_LOCAL_END}\n\n`;
    const once = stripConversionRelics(above);
    expect(stripConversionRelics(once.text)).toEqual({
      text: once.text,
      stripped: [],
      blanksCollapsed: 0,
    });
  });

  test("a side with no trailing newline keeps not having one", () => {
    expect(stripConversionRelics(`${OLD_LOCAL_BEGIN}\n/repo-cache/`)).toEqual({
      text: "/repo-cache/",
      stripped: [OLD_LOCAL_BEGIN],
      blanksCollapsed: 0,
    });
  });

  test("CRLF: a relic line goes with its \\r, neighbouring bytes are untouched", () => {
    // The pipeline reads latin1 and matches marker lines by trimmed text
    // (trim eats \r), so a CRLF-terminated relic is the same relic - and
    // every surviving line keeps its own \r and its own non-ASCII bytes.
    const side = `${OLD_LOCAL_BEGIN}\r\ncaf\xe9-cache/\r\n${OLD_LOCAL_END}\r\n`;
    expect(stripConversionRelics(side)).toEqual({
      text: "caf\xe9-cache/\r\n",
      stripped: [`${OLD_LOCAL_BEGIN}\r`, `${OLD_LOCAL_END}\r`],
      blanksCollapsed: 0,
    });
  });

  test("the relic set is CLOSED: exactly the retired vocabulary", () => {
    // Frozen historical spellings - the set never grows, and it dies with
    // this module's legacy vintage arms.
    expect([...CONVERSION_RELIC_LINES].sort()).toEqual(
      [
        "# repo-platform:local-section",
        OLD_SENTINEL,
        OLD_LOCAL_BEGIN,
        OLD_LOCAL_END,
        GUIDANCE,
      ].sort(),
    );
  });
});

// The single owner of "does this declaration's carry strip?" - the
// rebuild and the tripwire both ask here, so neither can strip a
// steady-state carry nor miss what the other subtracted.
describe("carriedSides / carriedRepoOwnedText", () => {
  const GUIDANCE = "# Add repository-specific ignore patterns in this section only.";
  const above = `${OLD_LOCAL_BEGIN}\n${GUIDANCE}\n/repo-cache/\n${OLD_LOCAL_END}\n\n`;

  test("a RETIRED vintage's sides come back stripped and itemized", () => {
    const decl = { vintage: "bounded-region", path: "a", managed_begin: HB } as const;
    expect(carriedSides(`${above}${HB}\n*.old\n${HE}\n`, decl)).toEqual({
      above: "/repo-cache/\n\n",
      below: "",
      extraMarkers: false,
      stripped: [OLD_LOCAL_BEGIN, GUIDANCE, OLD_LOCAL_END],
      blanksCollapsed: 0,
    });
  });

  test("the CURRENT vintage strips nothing, even from relic-shaped repo content", () => {
    // The scope, owned in one place: a converted file whose repo-owned
    // side happens to hold a retired spelling keeps it forever.
    const decl = { vintage: "managed-region", path: "a", begin: HB, end: HE } as const;
    const content = `${above}${HB}\n*.old\n${HE}\n`;
    expect(carriedSides(content, decl)).toEqual({
      above,
      below: "",
      extraMarkers: false,
      stripped: [],
      blanksCollapsed: 0,
    });
    expect(carriedRepoOwnedText(content, decl)).toBe(above);
  });

  test("carriedRepoOwnedText joins the stripped sides and answers null the same way", () => {
    const decl = { vintage: "bounded-region", path: "a", managed_begin: HB } as const;
    expect(carriedRepoOwnedText(`${above}${HB}\n*.old\n${HE}\n`, decl)).toBe("/repo-cache/\n\n");
    expect(carriedRepoOwnedText("no marker at all\n", decl)).toBeNull();
  });
});
