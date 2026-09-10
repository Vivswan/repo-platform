// The internal-link gate over the assembled site (docs/pages.md, "Internal
// links are checked across mounts"): linkinator crawls the CURRENT
// content's pages from a local static server serving the whole artifact at
// its Pages base, and every same-site link, fragment included, must resolve
// whichever mount serves the target - VitePress's own dead-link check stops
// at its tree, and a command mount's pages have no check of their own.
// Blocking by design: a broken link here ships a 404 on a green deploy.
// Historical tag tiers are targets but never seeds: history cannot be fixed
// (build.ts's tierStrictLinks draws the same line).

import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LinkChecker } from "linkinator";
import { walkHtml } from "./check_links.ts";

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

/** linkinator's local static server: only links back into it are the
 *  site's own; every other URL is external and the nightly check's. */
const LOCAL_SERVER = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(?=[/?#]|$)/;

/** A result URL as a site path ("/r/docs/x.html#id"), or null for an
 *  external one. linkinator reports its own server's URLs relative to the
 *  server root in one version and loopback-absolute in another, so both
 *  spellings are read and neither is depended on. */
function sitePath(url: string): string | null {
  if (/^https?:\/\//.test(url) && !LOCAL_SERVER.test(url)) return null;
  const path = url.replace(LOCAL_SERVER, "");
  return path.startsWith("/") ? path : `/${path}`;
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

/** The anchors of a page naming a fragment on this site, each resolved
 *  against the page's own URL (or its `<base href>`, which precedes the
 *  anchors in the document): the target as a site path plus the fragment.
 *  Only same-origin links count (`origin` stands in for the site's); a
 *  bare `#` names nothing. */
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
        const href = element.getAttribute("href");
        if (href === null) return;
        try {
          base = new URL(href, page);
        } catch {}
      },
    })
    .on("a[href]", {
      element(element) {
        const href = element.getAttribute("href");
        if (href === null || !href.includes("#")) return;
        let url: URL;
        try {
          url = new URL(href, base);
        } catch {
          return;
        }
        if (url.origin !== page.origin || url.hash.length < 2) return;
        rows.push({
          href: url.pathname + url.hash,
          path: decodedComponent(url.pathname),
          fragment: decodedComponent(url.hash.slice(1)),
        });
      },
    })
    .transform(html);
  return rows;
}

/** The fragments a page offers: every element id and anchor name, plus
 *  `top`, which every browser resolves. */
export function fragmentIds(html: string): Set<string> {
  const ids = new Set(["top"]);
  const add = (value: string | null) => {
    if (value !== null && value !== "") ids.add(value);
  };
  new HTMLRewriter()
    .on("[id]", { element: (element) => add(element.getAttribute("id")) })
    .on("a[name]", { element: (element) => add(element.getAttribute("name")) })
    .transform(html);
  return ids;
}

/** The artifact file a site path serves (index.html for a directory), or
 *  null when nothing is there or the path leaves the base: linkinator
 *  reports those, so the fragment pass stays silent on them. */
function servedFile(site: string, rootBase: string, path: string): string | null {
  if (!path.startsWith(rootBase)) return null;
  const file = resolve(site, path.slice(rootBase.length));
  if (file !== site && !file.startsWith(`${site}/`)) return null;
  const candidate =
    existsSync(file) && statSync(file).isDirectory() ? join(file, "index.html") : file;
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
}

/** Every fragment link on `pages` (site-relative HTML paths under
 *  `rootBase`) whose target page exists but carries no such id. */
export function brokenFragments(site: string, rootBase: string, pages: string[]): BrokenLink[] {
  const idsOf = new Map<string, Set<string>>();
  const broken: BrokenLink[] = [];
  for (const page of pages) {
    const pagePath = `${rootBase}${page}`;
    const html = readFileSync(join(site, page), "utf-8");
    for (const { href, path, fragment } of fragmentTargets(
      html,
      `https://site.invalid${pagePath}`,
    )) {
      const file = servedFile(site, rootBase, path);
      if (file === null) continue;
      let ids = idsOf.get(file);
      if (ids === undefined) {
        ids = fragmentIds(readFileSync(file, "utf-8"));
        idsOf.set(file, ids);
      }
      if (!ids.has(fragment)) {
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

/** Where the static server serves the artifact from so that the site's
 *  absolute links (which carry the Pages base) resolve: the artifact
 *  itself on a custom domain ("/"), else a scratch root holding the
 *  artifact under the base's directory through a symlink. Returns the
 *  server root and the path prefix every seed carries. */
function servedRoot(
  site: string,
  rootBase: string,
  scratch: string,
): { root: string; prefix: string } {
  if (rootBase === "/") return { root: site, prefix: "" };
  const root = join(scratch, "link-root");
  const alias = join(root, rootBase.slice(1, -1));
  mkdirSync(dirname(alias), { recursive: true });
  symlinkSync(site, alias);
  return { root, prefix: rootBase.slice(1) };
}

/** Crawl the current content of the assembled `site` (served under
 *  `rootBase`) and throw, after printing the list, on any broken same-site
 *  link. Returns the counts the caller logs. A crawl that judged nothing
 *  is failed-to-look, never link-free. */
export async function checkSiteLinks(
  site: string,
  rootBase: string,
  tiers: TierScope[],
  scratch: string,
): Promise<{ pages: number; judged: number }> {
  const seeds = seedPages(walkHtml(site), tiers);
  if (seeds.length === 0) {
    throw new Error(
      `${site} holds no page built from HEAD - the layout always has one, so nothing was checked`,
    );
  }
  const { root, prefix } = servedRoot(site, rootBase, scratch);
  // Fragments are judged here (brokenFragments), not by linkinator: its
  // fragment check reads a target it reached with a HEAD request as an
  // empty document and reports every anchor on it missing.
  const result = await new LinkChecker().check({
    path: seeds.map((page) => prefix + page),
    serverRoot: root,
    concurrency: 25,
    timeout: 30_000,
    linksToSkip: async (link) => !LOCAL_SERVER.test(link),
  });
  const judged = result.links.filter((link) => link.state !== "SKIPPED");
  if (judged.length === 0) {
    throw new Error("the link crawl judged zero links - that is failed-to-look, never link-free");
  }
  const broken = sortBroken([
    ...collectInternalBroken(result.links),
    ...brokenFragments(site, rootBase, seeds),
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
