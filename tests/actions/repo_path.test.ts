import { describe, expect, test } from "bun:test";
import { pathProblem } from "../../actions/shared/repo_path";

describe("pathProblem", () => {
  test.each([
    ["a/b.txt", null],
    ["/abs", "is absolute"],
    ["a/../b", "carries an empty, '.', or '..' segment"],
    ["a//b", "carries an empty, '.', or '..' segment"],
    [".git/config", "carries a .git segment"],
    ["a\\b", "contains a backslash"],
    // A NUL or an over-long name makes a stat throw instead of answer; a tab
    // is a legal name the grammar refuses as policy. Neither reaches a stat.
    ["a/b\u0000c", "carries a control character"],
    ["a/b\tc", "carries a control character"],
    [`a/${"b".repeat(255)}`, null],
    [`a/${"b".repeat(256)}`, "has a segment over 255 bytes"],
    [Array(4).fill("c".repeat(255)).join("/"), null],
    [Array(17).fill("c".repeat(255)).join("/"), "is longer than 1024 bytes"],
  ])("%s -> %p", (path, problem) => {
    expect(pathProblem(path)).toBe(problem);
  });
});
