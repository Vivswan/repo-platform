// Unit tests for render_goldens' sha sentinel normalizer. The renderer
// itself runs against real copier output (bun run renders:check gates the
// committed goldens); these pin the substitution's edge cases: only the
// true scratch sha (or a 7-plus-char prefix of it) becomes the sentinel,
// back-to-back occurrences all normalize, and a pre-stamped sentinel is
// rejected instead of false-matching the committed goldens.

import { describe, expect, test } from "bun:test";
import { SHA_SENTINEL, shaNormalizer } from "../../scripts/render_goldens";

const SHA = "98026c9abcdef0123456789abcdef0123456789a";
const SHORT = SHA.slice(0, 7);
const normalize = shaNormalizer(SHA);

describe("shaNormalizer", () => {
  test("rejects anything but a full lowercase sha1", () => {
    expect(() => shaNormalizer(SHORT)).toThrow("not a full sha1");
    expect(() => shaNormalizer(SHA.toUpperCase())).toThrow("not a full sha1");
    expect(() => shaNormalizer(`${SHA}ff`)).toThrow("not a full sha1");
  });

  test("rewrites the full sha and the short form copier records", () => {
    expect(normalize("f", SHA)).toBe(SHA_SENTINEL);
    expect(normalize("f", `_commit: ${SHORT}\n`)).toBe(`_commit: ${SHA_SENTINEL}\n`);
    expect(normalize("f", `"commit": "${SHA.slice(0, 12)}"`)).toBe(`"commit": "${SHA_SENTINEL}"`);
  });

  test("leaves a sub-7-char prefix untouched", () => {
    expect(normalize("f", SHA.slice(0, 6))).toBe(SHA.slice(0, 6));
  });

  test("leaves a wrong sha untouched, so a mis-stamped render shows as drift", () => {
    const wrong = `${"f".repeat(7)}${SHA.slice(7)}`;
    expect(normalize("f", `_commit: ${wrong.slice(0, 7)}`)).toBe(`_commit: ${wrong.slice(0, 7)}`);
    expect(normalize("f", wrong)).toBe(wrong);
  });

  test("normalizes back-to-back occurrences, full and short", () => {
    expect(normalize("f", SHA + SHA)).toBe(SHA_SENTINEL + SHA_SENTINEL);
    expect(normalize("f", `${SHA}${SHORT} ${SHORT}`)).toBe(
      `${SHA_SENTINEL}${SHA_SENTINEL} ${SHA_SENTINEL}`,
    );
  });

  test("keeps hex that diverges from the sha, after the short and full forms", () => {
    expect(normalize("f", `${SHORT}ff`)).toBe(`${SHA_SENTINEL}ff`);
    expect(normalize("f", `${SHA}ff`)).toBe(`${SHA_SENTINEL}ff`);
  });

  test("rewrites the longest run that continues the sha, not a fixed width", () => {
    // 12 chars of true sha, then hex that diverges: the 12 are sha, the
    // tail is content.
    expect(normalize("f", `${SHA.slice(0, 12)}00`)).toBe(`${SHA_SENTINEL}00`);
  });

  test("throws on a pre-existing sentinel instead of false-matching the goldens", () => {
    expect(() => normalize("some/file", `x${SHA_SENTINEL}x`)).toThrow(
      `some/file: contains the sentinel "${SHA_SENTINEL}"`,
    );
  });
});
