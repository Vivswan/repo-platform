// The writer hashes rendered text and the validator hashes the bytes it reads back; the manifest only matches when a
// string digests as its utf-8 bytes, so node's encoding default is pinned here rather than trusted.

import { expect, test } from "bun:test";
import { sha256 } from "../../actions/shared/values.ts";

test("a string digests as its utf-8 bytes", () => {
  expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256("café\n")).toBe(sha256(Buffer.from("café\n", "utf-8")));
  expect(sha256("café\n")).not.toBe(sha256(Buffer.from("café\n", "latin1")));
});
