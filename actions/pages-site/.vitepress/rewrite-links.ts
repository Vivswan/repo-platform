// Links resolve in REPOSITORY space, the way they read on GitHub, then turn back into what the site serves: a route through
// the rewrite map, a directory URL, an asset at the base, or the file on GitHub at the tier's ref. Without this, `guide/README.md`
// and `../.github/workflows/ci.yml` both read fine on GitHub and 404 on the site, while VitePress's own dead-link check passes them.

import { posix } from "node:path";
import type { MarkdownEnv, MarkdownRenderer } from "vitepress";
import type { IncludeRoot } from "./conventions.ts";
import { sourcePathOf } from "./source-path.ts";
import { decodePathSegments, encodePathSegments } from "./url-path.ts";

export interface LinkScope {
  docsDir: string;
  includes: readonly IncludeRoot[];
  files: readonly string[];
  rewrites: Record<string, string>;
  /** The site base VitePress prefixes its own links with ("/repo/"). */
  base: string;
  repoUrl: string;
  ref: string;
}

/** A verbatim link is final, base included: VitePress's link rule would append `.html` to it or its router
 *  would take it as a page, so the rule marks the token for both to leave alone. */
export interface RewrittenLink {
  href: string;
  verbatim: boolean;
}

/** Hrefs the rule leaves alone: anything with a scheme or authority, and
 *  fragment-only or query-only links. */
const NOT_A_PATH = /^([a-z][a-z0-9+.-]*:|\/\/|[?#])/i;

function stagedPath(repoPath: string, scope: LinkScope): string | null {
  const roots = [
    { path: scope.docsDir, mount: "" },
    ...scope.includes.map((root) => ({ path: root.path, mount: `${root.mount}/` })),
  ].sort((a, b) => b.path.length - a.path.length);
  for (const root of roots) {
    if (repoPath === root.path) return root.mount.replace(/\/$/, "");
    if (repoPath.startsWith(`${root.path}/`))
      return root.mount + repoPath.slice(root.path.length + 1);
  }
  return null;
}

/** A directory written with its slash and an unknown extensionless name stay site paths, so VitePress's dead-link check
 *  reports a missing one; a directory with an index page is its directory URL, the way GitHub shows its README. */
function servedRoute(
  staged: string,
  writtenAsDirectory: boolean,
  scope: LinkScope,
): { kind: "page" | "directory" | "asset"; path: string } | null {
  if (staged.startsWith("public/")) {
    return {
      kind: "asset",
      path: staged.slice("public/".length) + (writtenAsDirectory ? "/" : ""),
    };
  }
  const files = new Set(scope.files);
  const index = staged === "" ? "index.md" : `${staged}/index.md`;
  const hasIndex = files.has(index) || Object.values(scope.rewrites).includes(index);
  if (writtenAsDirectory || hasIndex) return { kind: "directory", path: staged };
  if (files.has(staged) || /\.(md|html?)$/i.test(staged)) {
    return { kind: "page", path: scope.rewrites[staged] ?? staged };
  }
  if (files.has(`${staged}.md`)) {
    return { kind: "page", path: scope.rewrites[`${staged}.md`] ?? staged };
  }
  return posix.extname(staged) === "" ? { kind: "page", path: staged } : null;
}

/** The link a page renders, given the page it sits on (its rewritten
 *  relative path, VitePress's `env.relativePath`, which shares the source's
 *  directory). The path math runs on file names and the result goes back
 *  out percent-encoded: VitePress decodes the href once more when it
 *  renders, so a literal `%` in a name must reach it as `%25`. */
export function rewriteLink(href: string, relativePath: string, scope: LinkScope): RewrittenLink {
  const asIs = { href, verbatim: false };
  if (NOT_A_PATH.test(href)) return asIs;
  const suffixAt = href.search(/[?#]/);
  const rawPath = suffixAt === -1 ? href : href.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : href.slice(suffixAt);
  if (rawPath === "") return asIs;
  const path = decodePathSegments(rawPath);
  const trailing = path.endsWith("/") ? "/" : "";
  const pageDir = posix.dirname(relativePath);
  // A site-absolute link already names a staged path (VitePress prefixes
  // the base); only the rewrite map applies.
  if (path.startsWith("/")) {
    const target = scope.rewrites[posix.normalize(path.slice(1))];
    return target === undefined
      ? asIs
      : { href: `/${encodePathSegments(target)}${suffix}`, verbatim: false };
  }
  const pageRepoPath = sourcePathOf(scope.docsDir, scope.includes, relativePath);
  const repoTarget = posix
    .normalize(posix.join(posix.dirname(pageRepoPath), path))
    .replace(/(.)\/$/, "$1");
  if (repoTarget === ".." || repoTarget.startsWith("../")) return asIs;
  const staged = stagedPath(repoTarget === "." ? "" : repoTarget, scope);
  const route = staged === null ? null : servedRoute(staged, trailing === "/", scope);
  if (route === null) {
    // GitHub's file route 404s on a directory; a directory is known here
    // by its trailing slash or by being the repository root itself.
    if (repoTarget === ".")
      return { href: `${scope.repoUrl}/tree/${scope.ref}${suffix}`, verbatim: false };
    const view = trailing === "/" ? "tree" : "blob";
    return {
      href: `${scope.repoUrl}/${view}/${scope.ref}/${encodePathSegments(repoTarget)}${suffix}`,
      verbatim: false,
    };
  }
  if (route.kind === "asset") {
    return { href: `${scope.base}${encodePathSegments(route.path)}${suffix}`, verbatim: true };
  }
  const relative = posix.relative(pageDir === "." ? "" : pageDir, route.path);
  if (relative === "") return { href: `./${suffix}`, verbatim: false };
  return {
    href: `${encodePathSegments(relative)}${route.kind === "directory" ? "/" : ""}${suffix}`,
    verbatim: false,
  };
}

/** Installs the rewrite on every link_open token, ahead of the renderer
 *  (VitePress's link rule runs at render time and reads the attr). A
 *  verbatim link gets `target="_self"`: the one attribute that makes
 *  VitePress's rule skip the token and its router do a full page load. */
export function rewriteLinksRule(md: MarkdownRenderer, scope: LinkScope): void {
  md.core.ruler.push("fleet_rewrite_links", (state) => {
    const relativePath = (state.env as MarkdownEnv).relativePath ?? "index.md";
    for (const block of state.tokens) {
      if (block.type !== "inline" || block.children === null) continue;
      for (const token of block.children) {
        if (token.type !== "link_open") continue;
        const href = token.attrGet("href");
        if (href === null) continue;
        const link = rewriteLink(href, relativePath, scope);
        token.attrSet("href", link.href);
        if (link.verbatim) token.attrSet("target", "_self");
      }
    }
  });
}
