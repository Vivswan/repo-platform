import { describe, expect, test } from "bun:test";
import { rewriteSrcPath } from "../../.github/scripts/sync/src_path.ts";

describe("rewriteSrcPath", () => {
  test("rewrites the line and returns the recorded value", () => {
    const result = rewriteSrcPath("_commit: v1\n_src_path: /home/u/repo\n", "gh:o/r");
    expect(result).toEqual({
      recorded: "/home/u/repo",
      rewritten: "_commit: v1\n_src_path: gh:o/r\n",
    });
  });

  test("normalizes formatting even when the value already matches", () => {
    const result = rewriteSrcPath("_src_path:   gh:o/r\n", "gh:o/r");
    expect(result).toEqual({ recorded: "gh:o/r", rewritten: "_src_path: gh:o/r\n" });
  });

  test("returns null when no _src_path line exists", () => {
    expect(rewriteSrcPath("_commit: v1\n", "gh:o/r")).toBeNull();
  });

  test("only the first _src_path line anchors the recorded value", () => {
    const result = rewriteSrcPath("_src_path: a\nother: x\n", "gh:o/r");
    expect(result?.recorded).toBe("a");
    expect(result?.rewritten).toBe("_src_path: gh:o/r\nother: x\n");
  });
});
