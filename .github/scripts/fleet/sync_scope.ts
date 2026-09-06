// The fleet scope grammar, one owner for the directive parser and both selectors: `all`, the
// visibility tokens `public` and `private`, or owner/name slugs, comma-separated. Visibility is
// known only where discovery ran (fail-closed: not discovered as public counts as private), so
// the plan expands the tokens; the read-directives leg passes them through as written.

import { isSlug } from "./repos_registry.ts";

export type Visibility = "public" | "private";
export type ScopeEntryKind = "all" | Visibility | "slug" | "invalid";

export function classifyEntry(entry: string): ScopeEntryKind {
  const folded = entry.toLowerCase();
  if (folded === "all" || folded === "public" || folded === "private") return folded;
  return isSlug(entry) ? "slug" : "invalid";
}

export type Scope =
  | { kind: "all" }
  | { kind: "list"; visibility: Set<Visibility>; slugs: Set<string> };

/** The whole fleet for "" and "all", else the folded list. Messages carry counts, never
 *  entries: a dispatch entry may be a private slug and the caller's log is public. */
export function parseScope(raw: string): Scope | { kind: "error"; message: string } {
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
  const visibility = new Set<Visibility>();
  const slugs = new Set<string>();
  let invalid = 0;
  let alls = 0;
  for (const entry of entries) {
    const kind = classifyEntry(entry);
    if (kind === "all") alls++;
    else if (kind === "slug") slugs.add(entry.toLowerCase());
    else if (kind === "invalid") invalid++;
    else visibility.add(kind);
  }
  if (alls > 0) {
    return {
      kind: "error",
      message: '"all" mixes with nothing: pass all alone, or public, private, and owner/name slugs',
    };
  }
  if (invalid > 0) {
    return {
      kind: "error",
      message: `${invalid} of ${entries.length} scope entries are neither owner/name slugs nor public/private (values withheld - they may be private slugs)`,
    };
  }
  return { kind: "list", visibility, slugs };
}

/** Where the scope came from: the workflow_call input (public text off a main commit, ridden
 *  in as ONLY_REPO) or the typed dispatch input (may be a private slug). */
export type ScopeSource = "call" | "dispatch";

export function scopeSelects(scope: Scope, repo: string, isPrivate: boolean): boolean {
  if (scope.kind === "all") return true;
  return (
    scope.slugs.has(repo.toLowerCase()) || scope.visibility.has(isPrivate ? "private" : "public")
  );
}

/** Why a list scope cannot run, counts only: a slug naming no known repo (a partial match
 *  would silently narrow the scope), or on the called path a slug naming a private repo (a
 *  directive is public text, so private repos ride only under the `private` token). Null
 *  when it can. `known` maps folded slugs to their visibility. */
export function scopeRefusal(
  scope: Scope,
  known: ReadonlyMap<string, boolean>,
  source: ScopeSource,
): string | null {
  if (scope.kind === "all") return null;
  const slugs = [...scope.slugs];
  const missing = slugs.filter((slug) => !known.has(slug)).length;
  if (missing > 0) {
    return (
      `${missing} of ${slugs.length} scoped repos matched no managed repository (values withheld - ` +
      "they may be private slugs): a repo you scoped to is not in managed (or the discovered list), " +
      "or it is listed in exclude; check the spelling (matching ignores case)"
    );
  }
  if (source === "call") {
    const hidden = slugs.filter((slug) => known.get(slug) === true).length;
    if (hidden > 0) {
      return `${hidden} of ${slugs.length} scoped repos are private: name private repositories with the \`private\` token, never by slug - a directive is public text on main`;
    }
  }
  return null;
}
