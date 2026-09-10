import { describe, expect, test } from "bun:test";
import {
  decodePathSegments,
  encodePathSegments,
} from "../../../actions/pages-site/.vitepress/url-path.ts";

describe("url-path", () => {
  test.each<[string, string]>([
    ["100%25", "100%"],
    ["a%23b/c%3Fd", "a#b/c?d"],
    ["caf%C3%A9", "café"],
    // A stray percent stays as written, the escapes beside it decode: the
    // spelling VitePress leaves after decoding the %25 of 100%25a%23b.
    ["100%a%23b", "100%a#b"],
    ["100%", "100%"],
    ["%E0%A4%A", "%E0%A4%A"],
    ["%ff%23", "%ff%23"],
    ["plain/path.html", "plain/path.html"],
  ])("%s decodes to %s", (encoded, decoded) => {
    expect(decodePathSegments(encoded)).toBe(decoded);
  });

  test("encoding keeps the slashes and escapes every delimiter, and round-trips", () => {
    expect(encodePathSegments("100%/a#b/c?d e")).toBe("100%25/a%23b/c%3Fd%20e");
    for (const name of ["100%a#b", "café/x y", "a?b#c%"]) {
      expect(decodePathSegments(encodePathSegments(name))).toBe(name);
    }
  });
});
