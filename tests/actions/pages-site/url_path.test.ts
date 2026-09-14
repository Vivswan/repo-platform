import { expect, test } from "bun:test";
import {
  decodePathSegments,
  encodePathSegments,
} from "../../../actions/pages-site/.vitepress/url-path.ts";

// A request path is decoded run-wise, the way a static server reads it and the spelling VitePress leaves after its
// own decode: a stray `%` or a non-UTF-8 run stays as written where decodeURIComponent on the whole string throws.
// The third column is the one canonical encoding, which keeps the slashes and escapes every delimiter.
test.each<[string, string, string]>([
  ["100%25", "100%", "100%25"],
  ["a%23b/c%3Fd", "a#b/c?d", "a%23b/c%3Fd"],
  ["c%3Fd%20e", "c?d e", "c%3Fd%20e"],
  ["caf%C3%A9", "café", "caf%C3%A9"],
  ["100%a%23b", "100%a#b", "100%25a%23b"],
  ["100%", "100%", "100%25"],
  ["%E0%A4%A", "%E0%A4%A", "%25E0%25A4%25A"],
  ["%ff%23", "%ff%23", "%25ff%2523"],
  ["plain/path.html", "plain/path.html", "plain/path.html"],
])("%s decodes to %s and re-encodes as %s", (encoded, decoded, canonical) => {
  expect(decodePathSegments(encoded)).toBe(decoded);
  expect(encodePathSegments(decoded)).toBe(canonical);
  expect(decodePathSegments(canonical)).toBe(decoded);
});
