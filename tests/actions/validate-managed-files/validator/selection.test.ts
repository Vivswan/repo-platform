import { describe, expect, test } from "bun:test";
import { type When, applies as writerApplies } from "../../../../actions/plan/files_config.ts";
import { applies, whenOf } from "../../../../actions/validate-managed-files/validator/selection.ts";

// The validator repeats the writer's rule because it cannot import the
// loader, so every clause over two modules is crossed with every selection.
describe("the validator's selection rule is the writer's", () => {
  const LISTS: (string[] | undefined)[] = [undefined, ["a"], ["b"], ["a", "b"]];
  const CLAUSES: (When | null)[] = [null];
  for (const modules of LISTS) {
    for (const any of LISTS) {
      for (const without of LISTS) {
        for (const privateRepo of [undefined, true, false]) {
          const when: When = {};
          if (modules !== undefined) when.modules = modules;
          if (any !== undefined) when.any = any;
          if (without !== undefined) when.without = without;
          if (privateRepo !== undefined) when.private = privateRepo;
          if (Object.keys(when).length > 0) CLAUSES.push(when);
        }
      }
    }
  }
  const SELECTIONS = LISTS.map((list) => list ?? []).flatMap((modules) =>
    [true, false].map((privateRepo) => ({ modules, private: privateRepo })),
  );

  test("every clause judges every selection the same way", () => {
    const table = CLAUSES.flatMap((when) =>
      SELECTIONS.map((selection) => ({
        when,
        selection,
        writer: writerApplies(when, selection),
        validator: applies(when, selection),
      })),
    );
    expect(table.length).toBe(192 * 8);
    expect(table.filter((row) => row.writer !== row.validator)).toEqual([]);
    expect(table.filter((row) => row.writer).length).toBeGreaterThan(0);
    expect(table.filter((row) => !row.writer).length).toBeGreaterThan(0);
  });

  test.each<{ reason: string; value: unknown; when: When | null | undefined }>([
    { reason: "an absent clause is always", value: undefined, when: null },
    { reason: "an empty clause is always", value: {}, when: null },
    {
      reason: "every key rides through",
      value: { modules: ["a"], any: ["b"], without: ["c"], private: true },
      when: { modules: ["a"], any: ["b"], without: ["c"], private: true },
    },
    { reason: "a key outside the grammar", value: { module: ["a"] }, when: undefined },
    { reason: "a list holding a non-name", value: { modules: ["a", 1] }, when: undefined },
    { reason: "a string where a list goes", value: { any: "a" }, when: undefined },
    { reason: "a string visibility", value: { private: "true" }, when: undefined },
    { reason: "a clause that is not a mapping", value: ["a"], when: undefined },
  ])("whenOf: $reason", ({ value, when }) => {
    expect(whenOf(value)).toEqual(when);
  });
});
