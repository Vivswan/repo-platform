import { describe, expect, test } from "bun:test";
import { rewriteSrcPath } from "../../.github/scripts/sync/src_path.ts";

describe("rewriteSrcPath", () => {
  test.each([
    {
      reason: "rewrites the line and returns the recorded value",
      text: "_commit: v1\n_src_path: /home/u/repo\n",
      expected: { recorded: "/home/u/repo", rewritten: "_commit: v1\n_src_path: gh:o/r\n" },
    },
    {
      reason: "normalizes formatting even when the value already matches",
      text: "_src_path:   gh:o/r\n",
      expected: { recorded: "gh:o/r", rewritten: "_src_path: gh:o/r\n" },
    },
    {
      reason: "returns null when no _src_path line exists",
      text: "_commit: v1\n",
      expected: null,
    },
    {
      // A second _src_path line is left verbatim: the regex is anchored
      // to the first match, never global.
      reason: "only the first _src_path line anchors the recorded value",
      text: "_src_path: a\nother: x\n_src_path: b\n",
      expected: { recorded: "a", rewritten: "_src_path: gh:o/r\nother: x\n_src_path: b\n" },
    },
  ])("$reason", ({ text, expected }) => {
    expect(rewriteSrcPath(text, "gh:o/r")).toEqual(expected);
  });
});
