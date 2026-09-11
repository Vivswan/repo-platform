// The scope grammar shared by the directive parser and both selectors, as
// whole parse results, whole selection verdicts, and the refusal texts.

import { describe, expect, test } from "bun:test";
import {
  classifyEntry,
  modulesAdmit,
  modulesFilterFor,
  modulesLeftOutLine,
  parseScope,
  type Scope,
  type ScopeSource,
  scopeRefusal,
  scopeSelects,
} from "../../.github/scripts/fleet/sync_scope.ts";
import { moduleRoster } from "../../.github/scripts/sync/modules.ts";

const CALL: ScopeSource = { kind: "call", sha: "8096c4920f84ec4122d14c5bd884703dd0d382ba" };
const DISPATCH: ScopeSource = { kind: "dispatch" };

// The real roster: the filter tests name real modules so a renamed module
// fails here, not in a fleet run.
const ROSTER = new Set(moduleRoster());

const ALL: Scope = { kind: "all" };
const list = (
  visibility: ("public" | "private")[],
  slugs: string[],
  modules: string[][] = [],
): Scope => ({
  kind: "list",
  visibility: new Set(visibility),
  slugs: new Set(slugs),
  modules: modules.map((names) => new Set(names)),
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
    { raw: "modules:pages", expected: list([], [], [["pages"]]) },
    {
      raw: "Modules: Pages + release-please",
      expected: list([], [], [["pages", "release-please"]]),
    },
    { raw: "modules:uv+uv", expected: list([], [], [["uv"]]) },
    {
      raw: "public, modules:pages, o/a, modules:rust+uv",
      expected: list(["public"], ["o/a"], [["pages"], ["rust", "uv"]]),
    },
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
      raw: "all, modules:pages",
      expected: {
        kind: "error",
        message:
          '"all" mixes with nothing: pass all alone, or public, private, and owner/name slugs',
      },
    },
    {
      raw: "o/a, just-a-name",
      expected: {
        kind: "error",
        message:
          "1 of 2 scope entries is neither owner/name slugs nor public/private (values withheld - they may be private slugs)",
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
    {
      raw: "modules:",
      expected: {
        kind: "error",
        message:
          "a modules: filter has an empty module name: write modules:<name>, or modules:<a>+<b> for the repos selecting every listed module",
      },
    },
    {
      raw: "public, modules:pages+",
      expected: {
        kind: "error",
        message:
          "a modules: filter has an empty module name: write modules:<name>, or modules:<a>+<b> for the repos selecting every listed module",
      },
    },
    {
      raw: "modules:pagez",
      expected: {
        kind: "error",
        message: `1 of 1 module names in the modules: filters is not a module files.yml knows (values withheld - this log is public); the modules are: ${moduleRoster().join(", ")}`,
      },
    },
    {
      raw: "modules:pages+Vivswan/secret, modules:o/hidden",
      expected: {
        kind: "error",
        message: `2 of 3 module names in the modules: filters are not modules files.yml knows (values withheld - this log is public); the modules are: ${moduleRoster().join(", ")}`,
      },
    },
  ])("$raw", ({ raw, expected }) => {
    expect(parseScope(raw, ROSTER)).toEqual(expected);
  });

  test("the roster names what the message lists, so a module the template retires drops out", () => {
    expect(parseScope("modules:pages", new Set(["uv", "rust"]))).toEqual({
      kind: "error",
      message:
        "1 of 1 module names in the modules: filters is not a module files.yml knows (values withheld - this log is public); the modules are: uv, rust",
    });
  });
});

describe("classifyEntry", () => {
  test.each([
    ["all", "all"],
    ["Public", "public"],
    ["PRIVATE", "private"],
    ["Vivswan/a", "slug"],
    ["modules:pages", "modules"],
    ["MODULES:", "modules"],
    ["module:pages", "invalid"],
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
    {
      reason: "a modules filter alone admits every visibility as a candidate",
      scope: list([], [], [["pages"]]),
      expected: ["o/pub-a", "o/pub-b", "o/priv"],
    },
    {
      reason: "a visibility token narrows the filter's candidates",
      scope: list(["private"], [], [["pages"]]),
      expected: ["o/priv"],
    },
    {
      reason: "a slug joins the filter's candidates as typed",
      scope: list(["private"], ["o/pub-a"], [["pages"]]),
      expected: ["o/pub-a", "o/priv"],
    },
  ])("$reason", ({ scope, expected }) => {
    expect(select(scope).map(([repo]) => repo)).toEqual(expected);
  });
});

describe("modules filters", () => {
  const PAGES_AND_RELEASE = list(["public"], ["o/named"], [["pages", "release-please"]]);
  const EITHER = list([], [], [["pages"], ["rust", "uv"]]);

  test.each<{ reason: string; scope: Scope; repo: string; filters: string[][] | null }>([
    {
      reason: "no filter in the scope",
      scope: list(["public"], ["o/a"]),
      repo: "o/a",
      filters: null,
    },
    { reason: "the whole fleet", scope: ALL, repo: "o/a", filters: null },
    {
      reason: "a repo named by slug is admitted as typed, any casing",
      scope: PAGES_AND_RELEASE,
      repo: "O/Named",
      filters: null,
    },
    {
      reason: "every other candidate is judged",
      scope: PAGES_AND_RELEASE,
      repo: "o/other",
      filters: [["pages", "release-please"]],
    },
  ])("modulesFilterFor: $reason", ({ scope, repo, filters }) => {
    expect(modulesFilterFor(scope, repo)).toEqual(
      filters === null ? null : filters.map((names) => new Set(names)),
    );
  });

  test.each<{ reason: string; scope: Scope; declared: string[]; admitted: boolean }>([
    {
      reason: "AND: every named module must be selected",
      scope: PAGES_AND_RELEASE,
      declared: ["uv", "pages", "release-please"],
      admitted: true,
    },
    {
      reason: "AND: one missing module fails the filter",
      scope: PAGES_AND_RELEASE,
      declared: ["uv", "pages"],
      admitted: false,
    },
    { reason: "an empty selection passes no filter", scope: EITHER, declared: [], admitted: false },
    {
      reason: "OR across filters: the first one passes",
      scope: EITHER,
      declared: ["pages"],
      admitted: true,
    },
    {
      reason: "OR across filters: the second one passes",
      scope: EITHER,
      declared: ["uv", "rust", "nightly"],
      admitted: true,
    },
    {
      reason: "OR across filters: half of each passes neither",
      scope: EITHER,
      declared: ["uv", "docs-site"],
      admitted: false,
    },
  ])("modulesAdmit: $reason", ({ scope, declared, admitted }) => {
    const filters = modulesFilterFor(scope, "o/judged");
    if (filters === null) throw new Error("the case must carry a filter");
    expect(modulesAdmit(filters, declared)).toBe(admitted);
  });

  test.each<{ scope: Scope; leftOut: number; line: string | null }>([
    { scope: ALL, leftOut: 0, line: null },
    { scope: list(["public"], []), leftOut: 3, line: null },
    {
      scope: EITHER,
      leftOut: 1,
      line: "modules filter: 1 adopted repo left out (selecting none of the listed module sets)",
    },
    {
      scope: PAGES_AND_RELEASE,
      leftOut: 0,
      line: "modules filter: 0 adopted repos left out (selecting none of the listed module sets)",
    },
  ])("modulesLeftOutLine: $leftOut left out -> $line", ({ scope, leftOut, line }) => {
    expect(modulesLeftOutLine(scope, leftOut)).toBe(line);
  });
});

describe("scopeRefusal", () => {
  const known = new Map<string, boolean>([
    ["o/pub", false],
    ["o/priv", true],
  ]);
  const PRIVATE_BY_SLUG =
    "1 of 2 scoped repos are private: name private repositories with the `private` token, never by slug - a directive is public text on main (the range judged at 8096c4920f84)";
  test.each<{ reason: string; scope: Scope; source: ScopeSource; expected: string | null }>([
    { reason: "all is never refused", scope: ALL, source: CALL, expected: null },
    {
      reason: "tokens alone are never refused",
      scope: list(["private"], []),
      source: CALL,
      expected: null,
    },
    {
      reason: "a modules filter alone is never refused",
      scope: list([], [], [["pages"]]),
      source: CALL,
      expected: null,
    },
    {
      reason: "a public slug on the called path runs",
      scope: list([], ["o/pub"]),
      source: CALL,
      expected: null,
    },
    {
      reason:
        "a private slug on the called path is refused, counting only, naming the judged commit",
      scope: list(["public"], ["o/pub", "o/priv"]),
      source: CALL,
      expected: PRIVATE_BY_SLUG,
    },
    {
      reason: "the same private slug from a dispatch runs (the typed input never prints)",
      scope: list(["public"], ["o/pub", "o/priv"]),
      source: DISPATCH,
      expected: null,
    },
    {
      reason: "an unknown slug is refused before visibility is judged",
      scope: list([], ["o/priv", "o/nope"]),
      source: CALL,
      expected:
        "1 of 2 scoped repos matched no fleet repository (values withheld - they may be private slugs): " +
        "not among the fleet token's pushable repositories under o - the grant was revoked, the " +
        "repository is archived or owned by someone else, or the slug is misspelled (matching ignores case)",
    },
  ])("$reason", ({ scope, source, expected }) => {
    expect(scopeRefusal(scope, known, source, "o")).toBe(expected);
  });
});
