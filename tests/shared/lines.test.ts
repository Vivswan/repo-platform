import { describe, expect, test } from "bun:test";
import { joinLines, splitLines, stripCr } from "../../.github/scripts/shared/lines.ts";

describe("splitLines / joinLines", () => {
  test("round-trips byte content exactly, trailing newline or not", () => {
    for (const text of ["a\nb\nc\n", "a\nb\nc", "", "\n", "a\r\nb\r\n", "\xff\nraw"]) {
      const data = Buffer.from(text, "latin1");
      expect(joinLines(splitLines(data)).equals(data)).toBe(true);
    }
  });

  test("splits on LF only, keeping CR bytes with their line", () => {
    const lines = splitLines(Buffer.from("a\r\nb\n"));
    expect(lines.map((line) => line.toString("latin1"))).toEqual(["a\r", "b", ""]);
  });
});

describe("stripCr", () => {
  test("drops every trailing CR and nothing else", () => {
    expect(stripCr(Buffer.from("a\r")).toString()).toBe("a");
    expect(stripCr(Buffer.from("a\r\r")).toString()).toBe("a");
    expect(stripCr(Buffer.from("a\rb")).toString()).toBe("a\rb");
    expect(stripCr(Buffer.from("")).toString()).toBe("");
  });
});
