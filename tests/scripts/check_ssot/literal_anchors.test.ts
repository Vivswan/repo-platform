// The literal-anchor rules' pure helpers (scripts/check/ssot/literal_anchors.ts).

import { describe, expect, test } from "bun:test";
import {
  inlineFunctionCopies,
  isOwnPagesOrigin,
} from "../../../scripts/check/ssot/literal_anchors.ts";

describe("inlineFunctionCopies", () => {
  const copy = (indent: string, body: string) =>
    [
      `${indent}async function resolve() {`,
      `${indent}  if (x) {`,
      `${indent}    ${body}`,
      `${indent}  }`,
      `${indent}}`,
    ].join("\n");

  test.each([
    { indent: "    ", reason: "four-space indent" },
    { indent: "  ", reason: "two-space indent - the nested close brace sits at indent+2" },
  ])(
    "extracts every copy byte-exactly, closing at the declaration's own indent ($reason)",
    ({ indent }) => {
      // Three copies, two of them identical, compared as an exact list: this
      // covers the early-close path (a nested `}` would truncate a copy),
      // body fidelity (a dropped byte would compare unequal), that each copy
      // carries its own bytes rather than the first one's, and that
      // identical copies are all kept (a deduplicating extractor fails).
      const a = copy(indent, "a();");
      const b = copy(indent, "b();");
      expect(inlineFunctionCopies(`head\n${a}\ntail\n${b}\n${a}\n`, "resolve")).toEqual([a, b, a]);
    },
  );

  test("returns nothing when the function is absent, so rules can fail loudly", () => {
    expect(inlineFunctionCopies("const resolve = 1;", "resolve")).toEqual([]);
  });
});

describe("isOwnPagesOrigin", () => {
  const at = (text: string) => text.indexOf("io/repo-platform");

  test("accepts this owner's Pages origin, hostname-boundary anchored", () => {
    const url = "see https://vivswan.github.io/repo-platform/ for the site";
    expect(isOwnPagesOrigin(url, at(url), "io", "Vivswan")).toBe(true);
    const bare = "vivswan.github.io/repo-platform";
    expect(isOwnPagesOrigin(bare, at(bare), "io", "Vivswan")).toBe(true);
    // Hostnames are case-insensitive; the answer casing must not matter.
    const cased = "Vivswan.GitHub.io/repo-platform";
    expect(isOwnPagesOrigin(cased, at(cased), "io", "vivswan")).toBe(true);
    // ... the io segment's own casing included.
    const casedIo = "vivswan.github.IO/repo-platform";
    expect(isOwnPagesOrigin(casedIo, casedIo.indexOf("IO/"), "IO", "Vivswan")).toBe(true);
  });

  test("rejects every other owner, the username-suffixed near miss included", () => {
    // A plain endsWith would exempt an owner whose name merely ENDS with
    // the username; the boundary check exists for this case.
    const nearMiss = "https://notvivswan.github.io/repo-platform/";
    expect(isOwnPagesOrigin(nearMiss, at(nearMiss), "io", "Vivswan")).toBe(false);
    const otherOwner = "https://someone.github.io/repo-platform/";
    expect(isOwnPagesOrigin(otherOwner, at(otherOwner), "io", "Vivswan")).toBe(false);
    // A subdomain of the origin is not the origin either.
    const subdomain = "https://other.vivswan.github.io/repo-platform/";
    expect(isOwnPagesOrigin(subdomain, at(subdomain), "io", "Vivswan")).toBe(false);
    const bareIo = "evil.io/repo-platform";
    expect(isOwnPagesOrigin(bareIo, at(bareIo), "io", "Vivswan")).toBe(false);
    // Only the io segment is ever a Pages origin.
    expect(isOwnPagesOrigin("x/repo-platform", 0, "x", "Vivswan")).toBe(false);
  });
});
