import { describe, expect, test } from "bun:test";
import { moduleRoster } from "../../.github/scripts/fleet/modules.ts";
import {
  branchDispatchRefusal,
  modulesAdmit,
  modulesFilterFor,
  parseScope,
  type Scope,
  scopeRefusal,
  scopeSelects,
} from "../../.github/scripts/fleet/sync_scope.ts";

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
const error = (message: string) => ({ kind: "error" as const, message });

describe("parseScope", () => {
  // The grammar's one home. The messages carry counts, never entries: a dispatch entry may be a private slug and the
  // caller's log is public. The roster in a message is the one handed in, so a module files.yml drops leaves it.
  const EMPTY_ENTRY = error(
    "the scope has an empty entry: pass owner/name slugs, public, or private separated by commas, with no stray or trailing comma",
  );
  const EMPTY_MODULE = error(
    "a modules: filter has an empty module name: write modules:<name>, or modules:<a>+<b> for the repos selecting every listed module",
  );
  const unknownModules = (unknown: number, total: number, roster: Iterable<string>) =>
    error(
      `${unknown} of ${total} module names in the modules: filters ${unknown === 1 ? "is not a module" : "are not modules"} files.yml knows (values withheld - this log is public); the modules are: ${[...roster].join(", ")}`,
    );
  test.each<{ raw: string; roster?: Set<string>; expected: ReturnType<typeof parseScope> }>([
    { raw: "", expected: ALL },
    { raw: "all", expected: ALL },
    { raw: "public", expected: list(["public"], []) },
    { raw: "Private", expected: list(["private"], []) },
    { raw: "public, Acme/Widgets", expected: list(["public"], ["acme/widgets"]) },
    { raw: "o/a,o/b, O/A", expected: list([], ["o/a", "o/b"]) },
    { raw: "public,private", expected: list(["public", "private"], []) },
    { raw: "modules:site", expected: list([], [], [["site"]]) },
    {
      raw: "Modules: Site + release-please",
      expected: list([], [], [["site", "release-please"]]),
    },
    { raw: "modules:uv+uv", expected: list([], [], [["uv"]]) },
    {
      raw: "public, modules:site, o/a, modules:rust+uv",
      expected: list(["public"], ["o/a"], [["site"], ["rust", "uv"]]),
    },
    { raw: "o/a,,o/b", expected: EMPTY_ENTRY },
    {
      raw: "all, o/a",
      expected: error(
        '"all" mixes with nothing: pass all alone, or public, private, and owner/name slugs',
      ),
    },
    {
      raw: "o/a, just-a-name",
      expected: error(
        "1 of 2 scope entries is neither owner/name slugs nor public/private (values withheld - they may be private slugs)",
      ),
    },
    {
      raw: "o/a, just-a-name, o/b/c",
      expected: error(
        "2 of 3 scope entries are neither owner/name slugs nor public/private (values withheld - they may be private slugs)",
      ),
    },
    {
      raw: "o/a, module:site",
      expected: error(
        "1 of 2 scope entries is neither owner/name slugs nor public/private (values withheld - they may be private slugs)",
      ),
    },
    { raw: "modules:", expected: EMPTY_MODULE },
    { raw: "modules:pagez", expected: unknownModules(1, 1, ROSTER) },
    {
      raw: "modules:site+Acme/secret, modules:o/hidden",
      expected: unknownModules(2, 3, ROSTER),
    },
    {
      raw: "modules:site",
      roster: new Set(["uv", "rust"]),
      expected: unknownModules(1, 1, ["uv", "rust"]),
    },
  ])("$raw", ({ raw, roster = ROSTER, expected }) => {
    expect(parseScope(raw, roster)).toEqual(expected);
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
      scope: list([], [], [["site"]]),
      expected: ["o/pub-a", "o/pub-b", "o/priv"],
    },
    {
      reason: "a visibility token narrows the filter's candidates",
      scope: list(["private"], [], [["site"]]),
      expected: ["o/priv"],
    },
    {
      reason: "a slug joins the filter's candidates as typed",
      scope: list(["private"], ["o/pub-a"], [["site"]]),
      expected: ["o/pub-a", "o/priv"],
    },
  ])("$reason", ({ scope, expected }) => {
    expect(select(scope).map(([repo]) => repo)).toEqual(expected);
  });
});

describe("modules filters", () => {
  const SITE_AND_RELEASE = list(["public"], ["o/named"], [["site", "release-please"]]);
  const EITHER = list([], [], [["site"], ["rust", "uv"]]);

  // A repo the scope names by slug is admitted as typed and never judged; every other candidate is judged by the
  // filters, AND within one, OR across them. Both selectors execute this pair.
  test.each<{
    reason: string;
    scope: Scope;
    repo: string;
    declared: string[];
    outcome: "unfiltered" | boolean;
  }>([
    {
      reason: "no filter in the scope",
      scope: list(["public"], ["o/a"]),
      repo: "o/a",
      declared: [],
      outcome: "unfiltered",
    },
    { reason: "the whole fleet", scope: ALL, repo: "o/a", declared: [], outcome: "unfiltered" },
    {
      reason: "a repo named by slug is admitted as typed, any casing",
      scope: SITE_AND_RELEASE,
      repo: "O/Named",
      declared: [],
      outcome: "unfiltered",
    },
    {
      reason: "AND: every named module must be selected",
      scope: SITE_AND_RELEASE,
      repo: "o/judged",
      declared: ["uv", "site", "release-please"],
      outcome: true,
    },
    {
      reason: "AND: one missing module fails the filter",
      scope: SITE_AND_RELEASE,
      repo: "o/judged",
      declared: ["uv", "site"],
      outcome: false,
    },
    {
      reason: "AND: the other missing module fails it too, so a filter dropping a name cannot pass",
      scope: SITE_AND_RELEASE,
      repo: "o/judged",
      declared: ["release-please"],
      outcome: false,
    },
    {
      reason: "an empty selection passes no filter",
      scope: EITHER,
      repo: "o/judged",
      declared: [],
      outcome: false,
    },
    {
      reason: "OR across filters: the first one passes",
      scope: EITHER,
      repo: "o/judged",
      declared: ["site"],
      outcome: true,
    },
    {
      reason: "OR across filters: the second one passes",
      scope: EITHER,
      repo: "o/judged",
      declared: ["uv", "rust", "nightly"],
      outcome: true,
    },
    {
      reason: "OR across filters: half of each passes neither",
      scope: EITHER,
      repo: "o/judged",
      declared: ["uv", "docs-site"],
      outcome: false,
    },
  ])("$reason", ({ scope, repo, declared, outcome }) => {
    const filters = modulesFilterFor(scope, repo);
    expect(filters === null ? "unfiltered" : modulesAdmit(filters, declared)).toBe(outcome);
  });
});

describe("scopeRefusal", () => {
  const known = new Set(["o/pub", "o/priv"]);
  test.each<{ reason: string; scope: Scope; expected: string | null }>([
    { reason: "all is never refused", scope: ALL, expected: null },
    { reason: "tokens alone are never refused", scope: list(["private"], []), expected: null },
    {
      reason: "a modules filter alone is never refused",
      scope: list([], [], [["site"]]),
      expected: null,
    },
    {
      reason: "known slugs run, a private one included (the writers count it, never name it)",
      scope: list(["public"], ["o/pub", "o/priv"]),
      expected: null,
    },
    {
      reason: "an unknown slug is refused",
      scope: list([], ["o/priv", "o/nope"]),
      expected:
        "1 of 2 scoped repos matched no fleet repository (values withheld - they may be private slugs): " +
        "not among the fleet token's pushable repositories under o - the grant was revoked, the " +
        "repository is archived or owned by someone else, or the slug is misspelled (matching ignores case)",
    },
  ])("$reason", ({ scope, expected }) => {
    expect(scopeRefusal(scope, known, "o")).toBe(expected);
  });
});

// A branch dispatch names one repository and nothing else; the messages are spelled here, independent of the source.
describe("branchDispatchRefusal", () => {
  const ONE = list([], ["o/a"]);
  const MANUAL =
    "manual is meaningless with branch: a branch sync commits onto the branch and opens no PR; drop manual";
  const ONE_REPO =
    "branch takes exactly one owner/name in repo: the sync commits onto that one repository's branch (no list, no all, no visibility token, no modules: filter)";

  test.each<{ reason: string; scope: Scope; manual: boolean; expected: string | null }>([
    {
      reason: "one slug without manual is the admitted shape",
      scope: ONE,
      manual: false,
      expected: null,
    },
    { reason: "manual beside branch", scope: ONE, manual: true, expected: MANUAL },
    { reason: "two slugs", scope: list([], ["o/a", "o/b"]), manual: false, expected: ONE_REPO },
    { reason: "all", scope: ALL, manual: false, expected: ONE_REPO },
    {
      reason: "a visibility token",
      scope: list(["public"], []),
      manual: false,
      expected: ONE_REPO,
    },
    {
      reason: "a slug beside a visibility token",
      scope: list(["private"], ["o/a"]),
      manual: false,
      expected: ONE_REPO,
    },
    {
      reason: "a modules filter",
      scope: list([], [], [["site"]]),
      manual: false,
      expected: ONE_REPO,
    },
    {
      reason: "a slug beside a modules filter",
      scope: list([], ["o/a"], [["site"]]),
      manual: false,
      expected: ONE_REPO,
    },
    { reason: "manual outranks the scope refusal", scope: ALL, manual: true, expected: MANUAL },
  ])("$reason", ({ scope, manual, expected }) => {
    expect(branchDispatchRefusal(scope, manual)).toBe(expected);
  });
});
