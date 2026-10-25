// One owner for the scope grammar: the dispatch input, the post-green leg's output, and both selectors.
// Only the plans know visibility and module selections, so the tokens are expanded there, not here.

const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/** An owner/name repository slug (GitHub's login and repo-name grammars). */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}

// A modules filter is `modules:<a>+<b>`: inside one filter the names are joined with "+", since the entry list already spends the comma.

const MODULES_PREFIX = "modules:";
const MODULES_JOINER = "+";

export type Visibility = "public" | "private";
export type ScopeEntryKind = "all" | Visibility | "slug" | "modules" | "invalid";

export function classifyEntry(entry: string): ScopeEntryKind {
  const folded = entry.toLowerCase();
  if (folded === "all" || folded === "public" || folded === "private") return folded;
  if (folded.startsWith(MODULES_PREFIX)) return "modules";
  return isSlug(entry) ? "slug" : "invalid";
}

/** `modules` holds one set per modules: filter, the names that filter ANDs; a repo passes when
 *  any set is a subset of its selection (modulesAdmit). Empty: no filter. */
export type Scope =
  | { kind: "all" }
  | { kind: "list"; visibility: Set<Visibility>; slugs: Set<string>; modules: Set<string>[] };

/** What one pass over the entries collected: the selection, and the counts the refusals are worded from. */
interface Tally {
  visibility: Set<Visibility>;
  slugs: Set<string>;
  modules: Set<string>[];
  entries: number;
  invalid: number;
  alls: number;
  moduleNames: number;
  emptyModuleNames: number;
  unknownModules: number;
}

function tallyEntries(entries: readonly string[], roster: ReadonlySet<string>): Tally {
  const tally: Tally = {
    visibility: new Set(),
    slugs: new Set(),
    modules: [],
    entries: entries.length,
    invalid: 0,
    alls: 0,
    moduleNames: 0,
    emptyModuleNames: 0,
    unknownModules: 0,
  };
  for (const entry of entries) {
    const kind = classifyEntry(entry);
    if (kind === "all") {
      tally.alls++;
    } else if (kind === "slug") {
      tally.slugs.add(entry.toLowerCase());
    } else if (kind === "invalid") {
      tally.invalid++;
    } else if (kind === "modules") {
      const names = entry
        .slice(MODULES_PREFIX.length)
        .split(MODULES_JOINER)
        .map((name) => name.trim().toLowerCase());
      tally.emptyModuleNames += names.filter((name) => name === "").length;
      tally.moduleNames += names.length;
      tally.unknownModules += names.filter((name) => name !== "" && !roster.has(name)).length;
      tally.modules.push(new Set(names));
    } else {
      tally.visibility.add(kind);
    }
  }
  return tally;
}

/** The refusal a tally earns, or null; each message carries counts alone, since the entries may be private slugs. */
function tallyProblem(tally: Tally, roster: ReadonlySet<string>): string | null {
  if (tally.alls > 0) {
    return '"all" mixes with nothing: pass all alone, or public, private, and owner/name slugs';
  }
  if (tally.invalid > 0) {
    return `${tally.invalid} of ${tally.entries} scope entries ${tally.invalid === 1 ? "is" : "are"} neither owner/name slugs nor public/private (values withheld - they may be private slugs)`;
  }
  if (tally.emptyModuleNames > 0) {
    return `a modules: filter has an empty module name: write modules:<name>, or modules:<a>${MODULES_JOINER}<b> for the repos selecting every listed module`;
  }
  const { unknownModules, moduleNames } = tally;
  if (unknownModules > 0) {
    return `${unknownModules} of ${moduleNames} module names in the modules: filters ${unknownModules === 1 ? "is not a module" : "are not modules"} files.yml knows (values withheld - this log is public); the modules are: ${[...roster].join(", ")}`;
  }
  return null;
}

/** Messages carry counts, never entries: a dispatch entry may be a private slug and the caller's log is public. A filter naming a
 *  module outside `roster` (modules.ts's moduleRoster) is refused here, before any repository is probed. */
export function parseScope(
  raw: string,
  roster: ReadonlySet<string>,
): Scope | { kind: "error"; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "all") return { kind: "all" };
  const entries = trimmed.split(",").map((entry) => entry.trim());
  if (entries.includes("")) {
    return {
      kind: "error",
      message:
        "the scope has an empty entry: pass owner/name slugs, public, or private separated by commas, with no stray or trailing comma",
    };
  }
  const tally = tallyEntries(entries, roster);
  const problem = tallyProblem(tally, roster);
  if (problem !== null) return { kind: "error", message: problem };
  return { kind: "list", visibility: tally.visibility, slugs: tally.slugs, modules: tally.modules };
}

export function scopeSelects(scope: Scope, repo: string, isPrivate: boolean): boolean {
  if (scope.kind === "all") return true;
  if (scope.slugs.has(repo.toLowerCase())) return true;
  if (scope.visibility.size === 0) return scope.modules.length > 0;
  return scope.visibility.has(isPrivate ? "private" : "public");
}

export function modulesFilterFor(scope: Scope, repo: string): Set<string>[] | null {
  if (scope.kind !== "list" || scope.modules.length === 0) return null;
  return scope.slugs.has(repo.toLowerCase()) ? null : scope.modules;
}

export function modulesAdmit(
  filters: readonly ReadonlySet<string>[],
  declared: readonly string[],
): boolean {
  const selected = new Set(declared);
  return filters.some((names) => [...names].every((name) => selected.has(name)));
}

/** Counts only: a left-out repo may be private. */
export function modulesLeftOutLine(scope: Scope, leftOut: number): string | null {
  if (scope.kind !== "list" || scope.modules.length === 0) return null;
  return `modules filter: ${leftOut} adopted ${leftOut === 1 ? "repo" : "repos"} left out (selecting none of the listed module sets)`;
}

/** Counts only: a slug may be private. `known` holds the fleet's folded slugs. */
export function scopeRefusal(
  scope: Scope,
  known: ReadonlySet<string>,
  owner: string,
): string | null {
  if (scope.kind === "all") return null;
  const slugs = [...scope.slugs];
  const missing = slugs.filter((slug) => !known.has(slug)).length;
  if (missing > 0) {
    return (
      `${missing} of ${slugs.length} scoped repos matched no fleet repository (values withheld - ` +
      `they may be private slugs): not among the fleet token's pushable repositories under ${owner} - ` +
      "the grant was revoked, the repository is archived or owned by someone else, or the slug is " +
      "misspelled (matching ignores case)"
    );
  }
  return null;
}

/** A branch dispatch commits onto one repository's branch and opens no PR, so a scope that could select
 *  two repositories, a `manual` that only governs a PR's auto-merge, or an `add_modules` edit the branch's own
 *  registration should carry, is a dispatch that means nothing. */
export function branchDispatchRefusal(
  scope: Scope,
  manual: boolean,
  addsModules: boolean,
): string | null {
  if (manual) {
    return "manual is meaningless with branch: a branch sync commits onto the branch and opens no PR; drop manual";
  }
  if (addsModules) {
    return "add_modules does not combine with branch: a branch sync writes the selection the branch already declares, so edit the modules list on the branch instead";
  }
  const oneSlug =
    scope.kind === "list" &&
    scope.slugs.size === 1 &&
    scope.visibility.size === 0 &&
    scope.modules.length === 0;
  if (oneSlug) return null;
  return "branch takes exactly one owner/name in repo: the sync commits onto that one repository's branch (no list, no all, no visibility token, no modules: filter)";
}

export type AddModules = { names: string[] } | { error: string };

/** The dispatch's add_modules value: counts, never the typed values, since the plan's log is public. The names come back
 *  in roster order (files.yml's, the canonical one), each once; the plan publishes that list as its output, so the rows
 *  take it as given. */
export function parseAddModules(raw: string, roster: readonly string[]): AddModules {
  const trimmed = raw.trim();
  if (trimmed === "") return { names: [] };
  const entries = trimmed.split(",").map((entry) => entry.trim().toLowerCase());
  if (entries.includes("")) {
    return {
      error:
        "add_modules has an empty entry: pass module names separated by commas, with no stray or trailing comma",
    };
  }
  const unknown = entries.filter((name) => !roster.includes(name)).length;
  if (unknown > 0) {
    return {
      error: `${unknown} of ${entries.length} names in add_modules ${unknown === 1 ? "is not a module" : "are not modules"} files.yml knows (values withheld - this log is public); the modules are: ${roster.join(", ")}`,
    };
  }
  const wanted = new Set(entries);
  return { names: roster.filter((name) => wanted.has(name)) };
}
