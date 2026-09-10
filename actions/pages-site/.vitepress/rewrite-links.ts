// Links resolve in REPOSITORY space, the way they read on GitHub. A page's
// relative link is resolved from the page's own repository path (the docs
// tree and every include root are staged from different places), then
// turned back into what the site serves: a target inside the docs tree or
// an include root becomes its on-site route (a source file name such as
// README.md or SKILL.md through the rewrite map, since VitePress rewrites
// only the href's `.md` to `.html` and knows nothing of the map), and a
// target elsewhere in the repository becomes a link to that file on GitHub
// at the tier's own ref. Without this, `../.github/workflows/ci.yml` and
// `guide/README.md` both read fine on GitHub and 404 on the site, while
// VitePress's own dead-link check passes them.

import { posix } from "node:path";
import type { MarkdownEnv, MarkdownRenderer } from "vitepress";
import type { IncludeRoot } from "../lib.ts";
import { sourcePathOf } from "./source-path.ts";

/** What a link resolves against: the staging layout (derive.ts's rewrite
 *  map, the docs directory, the include roots) and where the rest of the
 *  repository is read (its URL and this tier's ref). */
export interface LinkScope {
  docsDir: string;
  includes: readonly IncludeRoot[];
  rewrites: Record<string, string>;
  repoUrl: string;
  ref: string;
}

/** Hrefs the rule leaves alone: anything with a scheme or authority, and
 *  fragment-only or query-only links. */
const NOT_A_PATH = /^([a-z][a-z0-9+.-]*:|\/\/|[?#])/i;

/** The staged path a repository path serves from, or null when it is not
 *  on the site: under the docs directory it is the rest, under an include
 *  root's path it is that root's mount plus the rest (the longest path
 *  wins), the directory itself is "". */
function stagedPath(repoPath: string, scope: LinkScope): string | null {
  const roots = [
    { path: scope.docsDir, mount: "" },
    ...scope.includes.map((root) => ({ path: root.path, mount: `${root.mount}/` })),
  ].sort((a, b) => b.path.length - a.path.length);
  for (const root of roots) {
    if (repoPath === root.path) return root.mount === "" ? "" : root.mount;
    if (repoPath.startsWith(`${root.path}/`))
      return root.mount + repoPath.slice(root.path.length + 1);
  }
  return null;
}

/** A percent-encoded href path as the file name it names, segment by
 *  segment so an encoded `#` or `?` reads as the name's own character
 *  (decodeURI would keep it encoded and miss the rewrite map); a malformed
 *  escape stays as written. */
function decodedPath(path: string): string {
  try {
    return path.split("/").map(decodeURIComponent).join("/");
  } catch {
    return path;
  }
}

/** A file path percent-encoded segment by segment, so a `#` or `?` in a
 *  name goes out as path data rather than as the href's fragment or query. */
function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The href a link renders with, given the page it sits on (its rewritten
 *  relative path, VitePress's `env.relativePath`, which shares the source's
 *  directory). The path math runs on file names and the result goes back
 *  out percent-encoded: VitePress decodes the href once more when it
 *  renders, so a literal `%` in a name must reach it as `%25`. */
export function rewriteHref(href: string, relativePath: string, scope: LinkScope): string {
  if (NOT_A_PATH.test(href)) return href;
  const suffixAt = href.search(/[?#]/);
  const rawPath = suffixAt === -1 ? href : href.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : href.slice(suffixAt);
  if (rawPath === "") return href;
  const path = decodedPath(rawPath);
  const trailing = path.endsWith("/") ? "/" : "";
  const pageDir = posix.dirname(relativePath);
  // A site-absolute link already names a staged path (VitePress prefixes
  // the base); only the rewrite map applies.
  if (path.startsWith("/")) {
    const target = scope.rewrites[posix.normalize(path.slice(1))];
    return target === undefined ? href : `/${encodedPath(target)}${suffix}`;
  }
  const pageRepoPath = sourcePathOf(scope.docsDir, scope.includes, relativePath);
  const repoTarget = posix.normalize(posix.join(posix.dirname(pageRepoPath), path));
  if (repoTarget === ".." || repoTarget.startsWith("../")) return href;
  const staged = stagedPath(repoTarget === "." ? "" : repoTarget, scope);
  if (staged === null) {
    return `${scope.repoUrl}/blob/${scope.ref}/${encodedPath(repoTarget)}${suffix}`;
  }
  const mapped = scope.rewrites[staged];
  const relative = posix.relative(pageDir === "." ? "" : pageDir, mapped ?? staged);
  if (relative === "") return `./${suffix}`;
  return `${encodedPath(relative)}${mapped === undefined ? trailing : ""}${suffix}`;
}

/** Installs the rewrite on every link_open token, ahead of the renderer
 *  (VitePress's link rule runs at render time and reads the attr). */
export function rewriteLinksRule(md: MarkdownRenderer, scope: LinkScope): void {
  md.core.ruler.push("fleet_rewrite_links", (state) => {
    const relativePath = (state.env as MarkdownEnv).relativePath ?? "index.md";
    for (const block of state.tokens) {
      if (block.type !== "inline" || block.children === null) continue;
      for (const token of block.children) {
        if (token.type !== "link_open") continue;
        const href = token.attrGet("href");
        if (href !== null) token.attrSet("href", rewriteHref(href, relativePath, scope));
      }
    }
  });
}
