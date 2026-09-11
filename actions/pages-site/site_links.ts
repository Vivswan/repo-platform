// The internal-link gate over the assembled site (docs/pages.md, "Internal
// links are checked across mounts"): linkinator crawls the CURRENT
// content's pages from a loopback server that serves the whole artifact at
// its Pages base the way GitHub Pages does, and every same-site link,
// fragment included, must resolve whichever mount serves the target -
// VitePress's own dead-link check stops at its tree, and a command mount's
// pages have no check of their own. Blocking by design: a broken link here
// ships a 404 on a green deploy. Historical tag tiers are targets but never
// seeds: history cannot be fixed (build.ts's tierStrictLinks draws the same
// line).

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeHTML } from "entities";
import { LinkChecker } from "linkinator";
import { decodePathSegments, encodePathSegments } from "./.vitepress/url-path.ts";
import { sitePath, walkHtml } from "./check_links.ts";

/** One tier's place in the artifact and whether its content is current. */
export interface TierScope {
  /** Artifact path relative to the site root, "" or "<dir>/.../". */
  rel: string;
  /** Built from HEAD: its links are the author's to fix today. */
  strict: boolean;
}

/** The pages the gate seeds among `pages` (site-relative HTML paths):
 *  each belongs to the tier whose rel is the LONGEST prefix of its path
 *  (tiers nest: a versioned mount's root rel prefixes its latest/ and tag
 *  directories, and a "/" mount's "" prefixes everything), and only a
 *  strict tier's pages seed. */
export function seedPages(pages: string[], tiers: TierScope[]): string[] {
  return pages.filter((page) => {
    const owner = tiers
      .filter((tier) => page.startsWith(tier.rel))
      .sort((a, b) => b.rel.length - a.rel.length)[0];
    return owner?.strict === true;
  });
}

export interface BrokenLink {
  /** The linking page, as a site path. */
  page: string;
  /** The link as it resolves, as a site path with its fragment. */
  href: string;
  reason: string;
}

/** The broken same-site links among linkinator's results, one row per
 *  page-and-href, both as site paths. A fragment failure keeps its 2xx
 *  status and reads as the missing anchor. */
export function collectInternalBroken(
  links: { url: string; state: string; status?: number; parent?: string }[],
): BrokenLink[] {
  const rows = new Map<string, BrokenLink>();
  for (const link of links) {
    const href = sitePath(link.url);
    if (link.state !== "BROKEN" || href === null) continue;
    const page = link.parent === undefined ? "" : (sitePath(link.parent) ?? link.parent);
    const status = link.status ?? 0;
    const reason =
      href.includes("#") && status >= 200 && status < 300
        ? `no element with id '${href.slice(href.indexOf("#") + 1)}' on that page`
        : status === 0
          ? "unreachable"
          : `status ${status}`;
    rows.set(`${page}|${href}`, { page, href, reason });
  }
  return sortBroken([...rows.values()]);
}

function sortBroken(broken: BrokenLink[]): BrokenLink[] {
  return [...broken].sort((a, b) => a.page.localeCompare(b.page) || a.href.localeCompare(b.href));
}

/** A URL component decoded when it is well-formed, else as written: a
 *  browser resolves `#100%` to the element with that literal id. */
function decodedComponent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** An attribute's value as the browser reads it: HTMLRewriter hands over
 *  the source text, entities included. */
function attribute(
  element: { getAttribute(name: string): string | null },
  name: string,
): string | null {
  const raw = element.getAttribute(name);
  return raw === null ? null : decodeHTML(raw);
}

/** The anchors of a page naming a fragment on this site, each resolved
 *  against the page's own URL (or its `<base href>`, which precedes the
 *  anchors in the document): the target as a site path plus the fragment.
 *  Only same-origin links count; a bare `#` names nothing. */
export function fragmentTargets(
  html: string,
  pageUrl: string,
): { href: string; path: string; fragment: string }[] {
  const page = new URL(pageUrl);
  let base = page;
  const rows: { href: string; path: string; fragment: string }[] = [];
  new HTMLRewriter()
    .on("base[href]", {
      element(element) {
        const href = attribute(element, "href");
        if (href === null) return;
        try {
          base = new URL(href, page);
        } catch {}
      },
    })
    .on("a[href]", {
      element(element) {
        const href = attribute(element, "href");
        if (href === null || !href.includes("#")) return;
        let url: URL;
        try {
          url = new URL(href, base);
        } catch {
          return;
        }
        if (url.origin !== page.origin || url.hash.length < 2) return;
        // A text-fragment directive (`#intro:~:text=Hello`) names text, not
        // an element; the id before it, if any, is what the page must carry.
        const fragment = decodedComponent(url.hash.slice(1)).split(":~:")[0];
        if (fragment === "") return;
        rows.push({
          href: url.pathname + url.hash,
          path: decodePathSegments(url.pathname),
          fragment,
        });
      },
    })
    .transform(html);
  return rows;
}

/** The fragments a page offers: every element id and anchor name. */
export function fragmentIds(html: string): Set<string> {
  const ids = new Set<string>();
  const add = (value: string | null) => {
    if (value !== null && value !== "") ids.add(value);
  };
  new HTMLRewriter()
    .on("[id]", { element: (element) => add(attribute(element, "id")) })
    .on("a[name]", { element: (element) => add(attribute(element, "name")) })
    .transform(html);
  return ids;
}

/** Whether a page offering `ids` resolves `fragment`: one of its ids, or
 *  `top` in any letter case, which the browser reads as the top of the
 *  document when no element carries it. */
export function resolvesFragment(ids: Set<string>, fragment: string): boolean {
  return ids.has(fragment) || fragment.toLowerCase() === "top";
}

/** The file GitHub Pages serves for `path` (decoded, relative to `root`),
 *  or null when nothing is there or the path leaves the root: the file
 *  itself, a directory's index.html with or without the trailing slash, or
 *  `<path>.html` for an extensionless path. The one serving rule, so the
 *  crawl and the fragment pass judge a URL the same way. */
export function servedFile(root: string, path: string): string | null {
  const file = resolve(root, path.replace(/^\/+/, ""));
  if (file !== root && !file.startsWith(`${root}/`)) return null;
  const candidates = path.endsWith("/")
    ? [join(file, "index.html")]
    : [file, join(file, "index.html"), `${file}.html`];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The site-relative path a URL path names under `rootBase`, or null when
 *  it is outside the base; the base spelled without its slash is the base.
 *  The crawl's server and the fragment pass resolve through this alone. */
function underBase(rootBase: string, pathname: string): string | null {
  if (pathname === rootBase.slice(0, -1)) return "";
  return pathname.startsWith(rootBase) ? pathname.slice(rootBase.length) : null;
}

/** The HTML page a decoded site path serves, or null when it is outside
 *  the base, nothing is there, or the target is not an HTML page:
 *  linkinator reports the first two, and a fragment on another kind of
 *  file (`manual.pdf#page=2`) is the viewer's, not an element id. */
function servedPage(site: string, rootBase: string, path: string): string | null {
  const rel = underBase(rootBase, path);
  const file = rel === null ? null : servedFile(site, rel);
  return file !== null && /\.html?$/i.test(file) ? file : null;
}

/** Every fragment link on `pages` (site-relative HTML paths under
 *  `rootBase`, served at `origin`) whose target page exists but carries no
 *  such id. */
export function brokenFragments(
  site: string,
  rootBase: string,
  pages: string[],
  origin = "https://site.invalid",
): BrokenLink[] {
  const idsOf = new Map<string, Set<string>>();
  const broken: BrokenLink[] = [];
  for (const page of pages) {
    // Encoded as the browser addresses the page, so a `#` in its name is
    // part of the path the anchors resolve against.
    const pagePath = `${rootBase}${encodePathSegments(page)}`;
    const html = readFileSync(join(site, page), "utf-8");
    for (const { href, path, fragment } of fragmentTargets(html, `${origin}${pagePath}`)) {
      const file = servedPage(site, rootBase, path);
      if (file === null) continue;
      let ids = idsOf.get(file);
      if (ids === undefined) {
        ids = fragmentIds(readFileSync(file, "utf-8"));
        idsOf.set(file, ids);
      }
      if (!resolvesFragment(ids, fragment)) {
        broken.push({
          page: pagePath,
          href,
          reason: `no element with id '${fragment}' on that page`,
        });
      }
    }
  }
  return sortBroken(broken);
}

/** The failure list as printed: one `page -> href (reason)` line each. */
export function formatBroken(broken: BrokenLink[]): string {
  return broken.map(({ page, href, reason }) => `  ${page} -> ${href} (${reason})`).join("\n");
}

/** `site` served at `rootBase` on a loopback port by the Pages rule
 *  (servedFile); the base spelled without its slash reads as the base. */
function serveSite(site: string, rootBase: string): ReturnType<typeof Bun.serve> {
  const notFound = (request: Request) =>
    new Response(request.method === "HEAD" ? null : "not found", { status: 404 });
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const rel = underBase(rootBase, new URL(request.url).pathname);
      const file = rel === null ? null : servedFile(site, decodePathSegments(rel));
      if (file === null) return notFound(request);
      const body = Bun.file(file);
      return new Response(request.method === "HEAD" ? null : body, {
        headers: { "content-type": body.type },
      });
    },
  });
}

/** The deployed site's URL prefix as a match on a link: the parsed
 *  origin (host lowercased, default port dropped) plus the root base
 *  without its slash, escaped so the host's dots match themselves, then a
 *  path, query, fragment, or nothing. A sibling site on the same origin
 *  (`https://owner.github.io/other-repo/`) therefore stays external. */
export function ownSitePattern(origin: string, rootBase: string): RegExp {
  const prefix = new URL(origin).origin + rootBase.slice(0, -1);
  // The site's own parsed origin, escaped, never a visitor's input.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/?#]|$)`);
}

/** Crawl the current content of the assembled `site` (served under
 *  `rootBase`) and throw, after printing the list, on any broken same-site
 *  link. `origin` is the deployed site's (`https://owner.github.io`): a
 *  link spelled with it under the base is the site's own and is judged
 *  against the artifact; null when the build's layout is not the deployed
 *  one (the docs PR check builds one mount at the root), so such links
 *  stay external. Returns the counts the caller logs. A crawl that judged
 *  nothing is failed-to-look, never link-free. */
export async function checkSiteLinks(
  site: string,
  rootBase: string,
  tiers: TierScope[],
  origin: string | null,
): Promise<{ pages: number; judged: number }> {
  const seeds = seedPages(walkHtml(site), tiers);
  if (seeds.length === 0) {
    throw new Error(
      `${site} holds no page built from HEAD - the layout always has one, so nothing was checked`,
    );
  }
  const server = serveSite(site, rootBase);
  const local = `http://127.0.0.1:${server.port}`;
  const ownSite = origin === null ? null : ownSitePattern(origin, rootBase);
  let result: Awaited<ReturnType<LinkChecker["check"]>>;
  try {
    // Fragments are judged here (brokenFragments), not by linkinator: its
    // fragment check reads a target it reached with a HEAD request as an
    // empty document and reports every anchor on it missing.
    result = await new LinkChecker().check({
      path: seeds.map((page) => `${local}${rootBase}${encodePathSegments(page)}`),
      concurrency: 25,
      timeout: 30_000,
      linksToSkip: async (link) => sitePath(link) === null && !(ownSite?.test(link) ?? false),
      urlRewriteExpressions:
        ownSite === null
          ? []
          : [{ pattern: ownSite, replacement: `${local}${rootBase.slice(0, -1)}` }],
    });
  } finally {
    server.stop(true);
  }
  const judged = result.links.filter((link) => link.state !== "SKIPPED");
  if (judged.length === 0) {
    throw new Error("the link crawl judged zero links - that is failed-to-look, never link-free");
  }
  const broken = sortBroken([
    ...collectInternalBroken(result.links),
    ...brokenFragments(site, rootBase, seeds, origin ?? undefined),
  ]);
  if (broken.length > 0) {
    console.log(`broken internal links (page -> link):\n${formatBroken(broken)}`);
    throw new Error(
      `${broken.length} broken internal link${broken.length === 1 ? "" : "s"} in the current ` +
        "content (listed above) - every same-site link must resolve across the whole site",
    );
  }
  return { pages: seeds.length, judged: judged.length };
}
