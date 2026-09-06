// The scope grammar shared by the directive parser and both selectors, as
// whole parse results, whole selection verdicts, and the refusal texts.

import { describe, expect, test } from "bun:test";
import {
  classifyEntry,
  parseScope,
  type Scope,
  scopeRefusal,
  scopeSelects,
} from "../../.github/scripts/fleet/sync_scope.ts";

const ALL: Scope = { kind: "all" };
const list = (visibility: ("public" | "private")[], slugs: string[]): Scope => ({
  kind: "list",
  visibility: new Set(visibility),
  slugs: new Set(slugs),
});

describe("parseScope", () => {
  test.each<{ raw: string; expected: ReturnType<typeof parseScope> }>([
    { raw: "", expected: ALL },
    { raw: "all", expected: ALL },
    { raw: " ALL ", expected: ALL },
    { raw: "public", expected: list(["public"], []) },
    { raw: "Private", expected: list(["private"], []) },
    { raw: "public, Vivswan/Dotfiles", expected: list(["public"], ["vivswan/dotfiles"]) },
    { raw: "o/a,o/b, O/A", expected: list([], ["o/a", "o/b"]) },
    { raw: "public,private", expected: list(["public", "private"], []) },
    {
      raw: "o/a,,o/b",
      expected: {
        kind: "error",
        message:
          "the scope has an empty entry: pass owner/name slugs, public, or private separated by commas, with no stray or trailing comma",
      },
    },
    {
      raw: ",",
      expected: {
        kind: "error",
        message:
          "the scope has an empty entry: pass owner/name slugs, public, or private separated by commas, with no stray or trailing comma",
      },
    },
    {
      raw: "all, o/a",
      expected: {
        kind: "error",
        message:
          '"all" mixes with nothing: pass all alone, or public, private, and owner/name slugs',
      },
    },
    {
      raw: "o/a, just-a-name, o/b/c",
      expected: {
        kind: "error",
        message:
          "2 of 3 scope entries are neither owner/name slugs nor public/private (values withheld - they may be private slugs)",
      },
    },
  ])("$raw", ({ raw, expected }) => {
    expect(parseScope(raw)).toEqual(expected);
  });
});

describe("classifyEntry", () => {
  test.each([
    ["all", "all"],
    ["Public", "public"],
    ["PRIVATE", "private"],
    ["Vivswan/a", "slug"],
    ["steady", "invalid"],
    ["", "invalid"],
  ] as const)("%s -> %s", (entry, kind) => {
    expect(classifyEntry(entry)).toBe(kind);
  });
});

describe("scopeSelects", () => {
  // The fleet: two public repos, one private; each scope's whole selection.
  const fleet: [string, boolean][] = [
    ["o/pub-a", false],
    ["o/pub-b", false],
    ["o/priv", true],
  ];
  const select = (scope: Scope) => fleet.filter(([repo, p]) => scopeSelects(scope, repo, p));
  test.each<{ reason: string; scope: Scope; expected: string[] }>([
    { reason: "all takes everything", scope: ALL, expected: ["o/pub-a", "o/pub-b", "o/priv"] },
    {
      reason: "public takes the public repos",
      scope: list(["public"], []),
      expected: ["o/pub-a", "o/pub-b"],
    },
    { reason: "private takes the rest", scope: list(["private"], []), expected: ["o/priv"] },
    {
      reason: "a slug list takes exactly those, any casing",
      scope: list([], ["o/pub-b"]),
      expected: ["o/pub-b"],
    },
    {
      reason: "a token plus a slug unions",
      scope: list(["private"], ["o/pub-a"]),
      expected: ["o/pub-a", "o/priv"],
    },
    {
      reason: "both tokens are the whole fleet",
      scope: list(["public", "private"], []),
      expected: ["o/pub-a", "o/pub-b", "o/priv"],
    },
  ])("$reason", ({ scope, expected }) => {
    expect(select(scope).map(([repo]) => repo)).toEqual(expected);
  });
});

describe("scopeRefusal", () => {
  const known = new Map<string, boolean>([
    ["o/pub", false],
    ["o/priv", true],
  ]);
  const PRIVATE_BY_SLUG =
    "1 of 2 scoped repos are private: name private repositories with the `private` token, never by slug - a directive is public text on main";
  test.each<{ reason: string; scope: Scope; source: "call" | "dispatch"; expected: string | null }>(
    [
      { reason: "all is never refused", scope: ALL, source: "call", expected: null },
      {
        reason: "tokens alone are never refused",
        scope: list(["private"], []),
        source: "call",
        expected: null,
      },
      {
        reason: "a public slug on the called path runs",
        scope: list([], ["o/pub"]),
        source: "call",
        expected: null,
      },
      {
        reason: "a private slug on the called path is refused, counting only",
        scope: list(["public"], ["o/pub", "o/priv"]),
        source: "call",
        expected: PRIVATE_BY_SLUG,
      },
      {
        reason: "the same private slug from a dispatch runs (the typed input never prints)",
        scope: list(["public"], ["o/pub", "o/priv"]),
        source: "dispatch",
        expected: null,
      },
      {
        reason: "an unknown slug is refused before visibility is judged",
        scope: list([], ["o/priv", "o/nope"]),
        source: "call",
        expected:
          "1 of 2 scoped repos matched no managed repository (values withheld - they may be private slugs): a repo you scoped to is not in managed (or the discovered list), or it is listed in exclude; check the spelling (matching ignores case)",
      },
    ],
  )("$reason", ({ scope, source, expected }) => {
    expect(scopeRefusal(scope, known, source)).toBe(expected);
  });
});
