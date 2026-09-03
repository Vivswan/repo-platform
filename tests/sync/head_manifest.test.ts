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
  test("reads managed-region entries (the one grammar)", () => {
    const text = manifestOf({
      "AGENTS.md": { class: "split", grammar: "managed-region", begin: B, end: E, hash: null },
      "README.md": { class: "starter" },
    });
    expect([...headSplitEntries(text, "m").values()]).toEqual([
      { path: "AGENTS.md", begin: B, end: E },
    ]);
  });

  test("a split entry with NO grammar is refused loudly (pre-grammar manifest)", () => {
    const text = manifestOf({
      "AGENTS.md": { class: "split", marker: OLD_SENTINEL, managed: "above", hash: null },
    });
    expect(() => headSplitEntries(text, "m")).toThrow("predates the stamped split grammar");
    expect(() => headSplitEntries(text, "m")).toThrow("recover=recopy");
  });

  test("a grammar this sync does not read is refused, never skipped", () => {
    // Not the one grammar: a guessed boundary could overwrite repo-owned
    // bytes, so the reader refuses and every caller fails closed. The
    // retired vintages land here too, exactly as the old compose emitted
    // them: the one-time conversion shim is deleted (fleet censused
    // post-conversion), so the loud refusal with recovery advice is the
    // ONLY behavior.
    for (const { grammar, path, entry } of [
      {
        grammar: "prefix",
        path: "AGENTS.md",
        entry: { marker: OLD_SENTINEL },
        reason: "never a wire shape",
      },
      {
        grammar: "tail-marker",
        path: "AGENTS.md",
        entry: { marker: OLD_SENTINEL, managed: "above" },
        reason: "retired vintage the deleted shim converted",
      },
      {
        grammar: "bounded-region",
        path: ".gitignore",
        entry: {
          marker: HB,
          managed: "below",
          managed_end: HE,
          local_begin: OLD_LOCAL_BEGIN,
          local_end: OLD_LOCAL_END,
        },
        reason: "retired four-marker vintage, as the old compose stamped .gitignore",
      },
    ]) {
      const text = manifestOf({ [path]: { class: "split", grammar, ...entry, hash: null } });
      expect(() => headSplitEntries(text, "m")).toThrow(`split grammar "${grammar}"`);
      expect(() => headSplitEntries(text, "m")).toThrow("refusing to guess");
      expect(() => headSplitEntries(text, "m")).toThrow("recover=recopy");
    }
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

  test("a non-ASCII or missing marker string is refused", () => {
    expect(() =>
      headSplitEntries(
        manifestOf({ a: { class: "split", grammar: "managed-region", begin: B } }),
        "m",
      ),
    ).toThrow("printable-ASCII 'end' marker");
    expect(() =>
      headSplitEntries(
        manifestOf({
          a: { class: "split", grammar: "managed-region", begin: "# § begin", end: HE },
        }),
        "m",
      ),
    ).toThrow("printable-ASCII 'begin' marker");
  });
});

describe("repoOwnedSides / managedPart / repoOwnedText", () => {
  const decl = { path: "a", begin: B, end: E } as const;

  test("both sides around the region, the region as the managed part", () => {
    const content = `above\n${B}\nmanaged\n${E}\nbelow\n`;
    expect(repoOwnedSides(content, decl)).toEqual({ above: "above\n", below: "below\n" });
    expect(managedPart(content, decl)).toBe(`${B}\nmanaged\n${E}\n`);
    expect(repoOwnedText(content, decl)).toBe("above\n\nbelow\n");
  });

  test("a copy that does not split cleanly reads as null", () => {
    expect(repoOwnedSides("no markers\n", decl)).toBeNull();
    expect(repoOwnedSides(`${B}\ntwice\n${E}\n${B}\n${E}\n`, decl)).toBeNull();
    // A mid-line mention counts too (substring semantics).
    expect(repoOwnedSides(`mention ${B}\n${B}\nmanaged\n${E}\n`, decl)).toBeNull();
    expect(managedPart("no markers\n", decl)).toBeNull();
    expect(repoOwnedText("no markers\n", decl)).toBeNull();
  });

  test("an empty side joins as the other side alone", () => {
    expect(repoOwnedText(`${B}\nmanaged\n${E}\nbelow only\n`, decl)).toBe("below only\n");
    expect(repoOwnedText(`above only\n${B}\nmanaged\n${E}\n`, decl)).toBe("above only\n");
  });
});
