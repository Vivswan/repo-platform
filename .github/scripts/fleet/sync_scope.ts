// The fleet scope grammar, one owner for the directive parser and both selectors: `all`, the
// tokens `public` and `private`, owner/name slugs, or `modules:<a>+<b>` filters (the repos whose
// .repo-platform.yml selects every named module). Only the plans know visibility and module
// selections (fail-closed: not discovered as public counts as private), so they expand the tokens.

const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/** An owner/name repository slug (GitHub's login and repo-name grammars). */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}

const MODULES_PREFIX = "modules:";
// Inside one filter the names are joined with "+" (the entry list already spends the comma).
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

/** The whole fleet for "" and "all", else the folded list. `roster` is the template's module
 *  list (scripts/lib/module_manifests.ts's MODULE_ORDER): a filter naming anything else is refused
 *  here, before any repository is probed. Messages carry counts, never entries: a dispatch entry
 *  may be a private slug and the caller's log is public. */
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
  const visibility = new Set<Visibility>();
  const slugs = new Set<string>();
  const modules: Set<string>[] = [];
  let invalid = 0;
  let alls = 0;
  let emptyModuleNames = 0;
  let moduleNames = 0;
  let unknownModules = 0;
  for (const entry of entries) {
    const kind = classifyEntry(entry);
    if (kind === "all") alls++;
    else if (kind === "slug") slugs.add(entry.toLowerCase());
    else if (kind === "invalid") invalid++;
    else if (kind === "modules") {
      const names = entry
        .slice(MODULES_PREFIX.length)
        .split(MODULES_JOINER)
        .map((name) => name.trim().toLowerCase());
      emptyModuleNames += names.filter((name) => name === "").length;
      moduleNames += names.length;
      unknownModules += names.filter((name) => name !== "" && !roster.has(name)).length;
      modules.push(new Set(names));
    } else visibility.add(kind);
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
      message: `${invalid} of ${entries.length} scope entries ${invalid === 1 ? "is" : "are"} neither owner/name slugs nor public/private (values withheld - they may be private slugs)`,
    };
  }
  if (emptyModuleNames > 0) {
    return {
      kind: "error",
      message: `a modules: filter has an empty module name: write modules:<name>, or modules:<a>${MODULES_JOINER}<b> for the repos selecting every listed module`,
    };
  }
  if (unknownModules > 0) {
    return {
      kind: "error",
      message: `${unknownModules} of ${moduleNames} module names in the modules: filters ${unknownModules === 1 ? "is not a module" : "are not modules"} of this template (values withheld - this log is public); the modules are: ${[...roster].join(", ")}`,
    };
  }
  return { kind: "list", visibility, slugs, modules };
}

/** Where the scope came from: the workflow_call input (ONLY_REPO, public text off the merged
 *  pull requests and direct pushes in the judged range) or the typed dispatch input (may be a
 *  private slug). */
export type ScopeSource = { kind: "call"; sha: string } | { kind: "dispatch" };

/** Whether the scope admits `repo` before its module selection is known: named by slug, or passed
 *  by the visibility tokens (any visibility when only modules: filters constrain the fleet). The
 *  filters then still judge it: modulesFilterFor, then modulesAdmit over its declared list. */
export function scopeSelects(scope: Scope, repo: string, isPrivate: boolean): boolean {
  if (scope.kind === "all") return true;
  if (scope.slugs.has(repo.toLowerCase())) return true;
  if (scope.visibility.size === 0) return scope.modules.length > 0;
  return scope.visibility.has(isPrivate ? "private" : "public");
}

/** The modules: filters `repo` must pass, or null when none applies: the scope carries no filter,
 *  or it named the repo by slug (a slug is admitted as typed, its selection unread). */
export function modulesFilterFor(scope: Scope, repo: string): Set<string>[] | null {
  if (scope.kind !== "list" || scope.modules.length === 0) return null;
  return scope.slugs.has(repo.toLowerCase()) ? null : scope.modules;
}

/** The filters' verdict over a repo's declared module list: some filter names only modules the
 *  repo selects (AND inside a filter, OR across filters). */
export function modulesAdmit(
  filters: readonly ReadonlySet<string>[],
  declared: readonly string[],
): boolean {
  const selected = new Set(declared);
  return filters.some((names) => [...names].every((name) => selected.has(name)));
}

/** The plan's one line about the adopted repos its modules: filters left out, counts only (a
 *  left-out repo may be private). Null when the scope carries no filter. */
export function modulesLeftOutLine(scope: Scope, leftOut: number): string | null {
  if (scope.kind !== "list" || scope.modules.length === 0) return null;
  return `modules filter: ${leftOut} adopted ${leftOut === 1 ? "repo" : "repos"} left out (selecting none of the listed module sets)`;
}

/** Why a list scope cannot run, counts only: a slug naming no known repo, or on the called path
 *  a slug naming a private one (private repos ride under the token). `known`: folded slug ->
 *  private; `owner` names the discovery scope in the unknown-slug diagnosis. Null when it can run. */
export function scopeRefusal(
  scope: Scope,
  known: ReadonlyMap<string, boolean>,
  source: ScopeSource,
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
  if (source.kind === "call") {
    const hidden = slugs.filter((slug) => known.get(slug) === true).length;
    if (hidden > 0) {
      return `${hidden} of ${slugs.length} scoped repos are private: name private repositories with the \`private\` token, never by slug - a directive is public text (the range judged at ${source.sha.slice(0, 12)})`;
    }
  }
  return null;
}

/** Why a dispatch naming a `branch` cannot run, or null: the branch mode
 *  renders onto ONE repository's branch, so the scope must be exactly one
 *  slug (no tokens, no list, not all), and a recovery re-render has no PR
 *  to hold for review. Value-free like every other refusal here. */
export function branchScopeRefusal(scope: Scope, branch: string, recover: string): string | null {
  if (branch === "") return null;
  if (recover === "recopy") {
    return "branch cannot combine with recover=recopy: a recovery re-render is delivered through a manual-review PR, and the branch mode pushes onto an existing branch instead";
  }
  if (
    scope.kind === "all" ||
    scope.visibility.size > 0 ||
    scope.modules.length > 0 ||
    scope.slugs.size !== 1
  ) {
    return "branch needs repo to name exactly one owner/name: the sync renders onto that repository's branch instead of opening its own PR, so a list, a visibility or modules: token, all, or an empty repo cannot carry it";
  }
  return null;
}
