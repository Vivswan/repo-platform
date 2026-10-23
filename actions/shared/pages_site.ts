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

/** The regex matching the site's own URLs and nothing else on the origin: the base followed by one of `entries` (the
 *  artifact's top-level names) and a delimiter, or the base itself, the tail captured as `$1` for a remap (Rust regex
 *  has no lookahead). Entries rather than the base alone, because a user site's base is the bare origin, which it
 *  shares with every project site of the owner (`/<repo>/`). */
/** The characters the URL parser would not keep as a path's own: `%` starts an escape, `\\` becomes `/` under https,
 *  and the whitespace is dropped. Spelled as the href to such a file must spell them. */
const MANGLED: Record<string, string> = {
  "%": "%25",
  "\\": "%5C",
  "\t": "%09",
  "\n": "%0A",
  "\r": "%0D",
};

export function ownLinksPattern(site: PagesSite, entries: string[]): string {
  const base = RegExp.escape(site.origin + site.basePath.slice(0, -1));
  const own = entries.map(segmentPattern).join("|");
  return `^${base}(/(?:${own})(?:[/?#]|$)|/?(?:[?#]|$))`;
}

/** The regex matching every spelling of a link to the file `name`: the href a browser serializes (`caf%C3%A9`, a
 *  literal `%` as `%25`, `[` kept), each escape's hex in either case, and each kept character also percent-encoded,
 *  since lychee reads a link as the author spelled it and never normalizes it. */
function segmentPattern(name: string): string {
  const url = new URL("https://host/");
  url.pathname = `/${name.replace(/[%\\\t\n\r]/g, (char) => MANGLED[char])}`;
  const segment = url.pathname.slice(1);

  let pattern = "";
  for (const part of segment.split(/(%[0-9A-F]{2})/)) {
    if (part.startsWith("%")) {
      pattern += `%${hexClass(part.slice(1))}`;
      continue;
    }
    for (const char of part) {
      const hex = char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      pattern += `(?:${RegExp.escape(char)}|%${hexClass(hex)})`;
    }
  }
  return pattern;
}

/** `C3` as the regex `[Cc]3`. */
function hexClass(hex: string): string {
  return hex.replace(/[A-F]/g, (letter) => `[${letter}${letter.toLowerCase()}]`);
}
