import { describe, expect, test } from "bun:test";
import { applies, type Selection, type When } from "../../actions/shared/selection.ts";

// Every selection two modules can form, crossed with both visibilities; a
// row pins the whole set a clause admits, so a clause that drifts on any
// selection names the row.
const SELECTIONS: Record<string, Selection> = {
  "-/public": { modules: [], private: false },
  "-/private": { modules: [], private: true },
  "a/public": { modules: ["a"], private: false },
  "a/private": { modules: ["a"], private: true },
  "b/public": { modules: ["b"], private: false },
  "b/private": { modules: ["b"], private: true },
  "ab/public": { modules: ["a", "b"], private: false },
  "ab/private": { modules: ["a", "b"], private: true },
};
const EVERY = Object.keys(SELECTIONS);
const both = (...modules: string[]) =>
  modules.flatMap((selected) => [`${selected}/public`, `${selected}/private`]);

describe("applies", () => {
  const ROWS: { when: When | null; admits: string[] }[] = [
    { when: null, admits: EVERY },
    { when: { modules: ["a"] }, admits: both("a", "ab") },
    { when: { modules: ["a", "b"] }, admits: both("ab") },
    { when: { any: ["a", "b"] }, admits: both("a", "b", "ab") },
    { when: { any: ["b"] }, admits: both("b", "ab") },
    { when: { without: ["a"] }, admits: both("-", "b") },
    { when: { without: ["a", "b"] }, admits: both("-") },
    { when: { private: true }, admits: ["-/private", "a/private", "b/private", "ab/private"] },
    { when: { private: false }, admits: ["-/public", "a/public", "b/public", "ab/public"] },
    { when: { modules: ["a"], without: ["b"] }, admits: both("a") },
    { when: { modules: ["a"], any: ["a", "b"] }, admits: both("a", "ab") },
    { when: { modules: ["a"], any: ["b"] }, admits: both("ab") },
    { when: { any: ["a", "b"], without: ["a"] }, admits: both("b") },
    { when: { modules: ["a"], without: ["a"] }, admits: [] },
    { when: { any: ["a"], without: ["a"] }, admits: [] },
    { when: { modules: ["a"], private: true }, admits: ["a/private", "ab/private"] },
    { when: { without: ["a"], private: false }, admits: ["-/public", "b/public"] },
    {
      when: { modules: ["b"], any: ["a", "b"], without: ["a"], private: false },
      admits: ["b/public"],
    },
  ];
  test.each(ROWS.map((row) => ({ ...row, clause: JSON.stringify(row.when) })))(
    "$clause admits $admits",
    ({ when, admits }) => {
      expect(EVERY.filter((label) => applies(when, SELECTIONS[label]))).toEqual(admits);
    },
  );
});
