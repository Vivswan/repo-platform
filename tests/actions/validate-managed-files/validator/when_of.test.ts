import { describe, expect, test } from "bun:test";
import type { When } from "../../../../actions/shared/selection.ts";
import { whenOf } from "../../../../actions/validate-managed-files/validator/when_of.ts";

const MODULES = { a: { codeql_language: "python" }, b: { pin: {} }, c: { codeql_language: "go" } };

describe("whenOf", () => {
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
    {
      reason: "a list declared by module data expands to the modules declaring the key",
      value: { any: { declaring: "codeql_language" }, without: { declaring: "pin" } },
      when: { any: ["a", "c"], without: ["b"] },
    },
    { reason: "a derived list naming no key", value: { any: { declaring: 1 } }, when: undefined },
    {
      reason: "a derived list with a key outside the grammar",
      value: { any: { declares: "pin" } },
      when: undefined,
    },
    { reason: "a string visibility", value: { private: "true" }, when: undefined },
    { reason: "a clause that is not a mapping", value: ["a"], when: undefined },
  ])("$reason", ({ value, when }) => {
    expect(whenOf(value, MODULES)).toEqual(when);
  });
});
