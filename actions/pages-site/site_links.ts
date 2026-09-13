// linkinator crawls the current content's pages from a loopback server serving the whole artifact at its Pages base, so a link resolves whichever mount serves the target:
// VitePress's own dead-link check stops at its tree, and the hook's website has no check of its own.
// Historical tag tiers are targets but never seeds, since history cannot be fixed (tierStrictLinks in build.ts draws the same line).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeHTML } from "entities";
import { LinkChecker } from "linkinator";
import { decodePathSegments, encodePathSegments } from "./.vitepress/url-path.ts";

/** linkinator spells its own server's URLs both server-root-relative and
 *  loopback-absolute; both read as the site's, every other http(s) URL
 *  is external. */
const LOCAL_SERVER = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(?=[/?#]|$)/;

function sitePath(url: string): string | null {
  if (/^https?:\/\//.test(url) && !LOCAL_SERVER.test(url)) return null;
  const path = url.replace(LOCAL_SERVER, "");
  return path.startsWith("/") ? path : `/${path}`;
}

/** Pages serves `.htm` as well as `.html`. Every page of a strict tier seeds the crawl: version tiers are navigated through a <select>, not anchors, so a crawl from the root alone would never reach them. */
export function walkHtml(dir: string, prefix = ""): string[] {
  const pages: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(join(dir, rel)).isDirectory()) {
      pages.push(...walkHtml(dir, rel));
    } else if (/\.html?$/i.test(name)) {
      pages.push(rel);
    }
  }
  return pages;
}

export interface TierScope {
  /** Artifact path relative to the site root, "" or "<dir>/.../". */
  rel: string;
  /** Built from HEAD: its links are the author's to fix today. */
  strict: boolean;
}

/** A page belongs to the tier whose rel is the longest prefix of its path: tiers nest, a mount's root rel prefixing its latest/ and tag directories. */
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

/** A fragment failure keeps its 2xx status and reads as the missing anchor. */
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

/** Anchors resolve against the page's `<base href>` when it has one, which precedes them in the document. */
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

/** `top` in any letter case is the document top when no element carries it. */
export function resolvesFragment(ids: Set<string>, fragment: string): boolean {
  return ids.has(fragment) || fragment.toLowerCase() === "top";
}

/** The one Pages serving rule, so the crawl and the fragment pass judge a URL the same way. */
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

/** The base spelled without its slash is the base; the crawl's server and the fragment pass resolve through this alone. */
function underBase(rootBase: string, pathname: string): string | null {
  if (pathname === rootBase.slice(0, -1)) return "";
  return pathname.startsWith(rootBase) ? pathname.slice(rootBase.length) : null;
}

/** A fragment on a file that is not an HTML page (`manual.pdf#page=2`) is the viewer's, not an element id. */
function servedPage(site: string, rootBase: string, path: string): string | null {
  const rel = underBase(rootBase, path);
  const file = rel === null ? null : servedFile(site, rel);
  return file !== null && /\.html?$/i.test(file) ? file : null;
}

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

export function formatBroken(broken: BrokenLink[]): string {
  return broken.map(({ page, href, reason }) => `  ${page} -> ${href} (${reason})`).join("\n");
}

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

/** The host's dots are escaped, and the lookahead keeps a sibling site on the same origin (`https://owner.github.io/other-repo/`) external. */
export function ownSitePattern(origin: string, rootBase: string): RegExp {
  const prefix = new URL(origin).origin + rootBase.slice(0, -1);
  // The site's own parsed origin, escaped, never a visitor's input.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/?#]|$)`);
}

/** `origin` is the deployed site's (`https://owner.github.io`): a link spelled with it under the base is the site's own and is judged against the artifact.
 *  Null when the build's layout is not the deployed one (the docs PR check builds one mount at the root), so such links stay external. */
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
