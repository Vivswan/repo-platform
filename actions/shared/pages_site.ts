// Where GitHub Pages serves a repository (docs/modules/site.md, "The hook"), spelled once for the site-urls action,
// which hands the hook its base path, and the pages-site assembly, which lays the artifact out at it.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

export interface PagesSite {
  /** `https://<owner>.github.io`, the owner lowercased the way Pages serves it. */
  origin: string;
  /** `/` for the owner's user site, the repository named `<owner>.github.io` in any case; `/<repo>/` otherwise. */
  basePath: string;
}

/** Where Pages serves `repository` (`owner/repo`, as GITHUB_REPOSITORY spells it): the origin, and the base path
 *  `/` when the repository is the owner's user site or `/<repo>/` otherwise. */
export function pagesSite(repository: string): PagesSite {
  const [owner, repo] = repository.split("/");
  const host = `${owner.toLowerCase()}.github.io`;
  return {
    origin: `https://${host}`,
    basePath: repo.toLowerCase() === host ? "/" : `/${repo}/`,
  };
}

/** The regex matching the site's own URLs and nothing else on the origin: the delimiter after the base is captured
 *  as `$1` (Rust regex has no lookahead), so a project site's sibling on the same origin stays out. A user site's
 *  base is the bare origin, so it owns every link on it. */
export function ownLinksPattern(site: PagesSite): string {
  return `^${RegExp.escape(site.origin + site.basePath.slice(0, -1))}([/?#]|$)`;
}
