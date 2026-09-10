// The launcher's page index, built once per site build: every markdown page
// of the docs tree, in sidebar order (sidebar.ts, so the launcher's page
// and directory groups follow the sidebar), rendered through VitePress's
// shared markdown-it instance for its headings, mapped by page-index.ts,
// and inlined into the client bundle as `data`. Runs only inside a vitepress process, like any data
// loader. Pages render from their source as written, and VitePress expands
// `<!-- @include -->` only in its page transform, so a page with a directive
// VitePress would expand (one naming a readable file, resolved the way its
// processIncludes does) lists NO heading rows (page-index.ts's
// sourceHeaders): the unexpanded source would shift or collide the anchors
// after the include, and full-text search still reaches those headings. A
// directive whose file VitePress cannot read (missing, a directory, a path
// through a file) stays literal there too, so it changes nothing here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MarkdownEnv, SiteConfig } from "vitepress";
import type { IncludeRoot } from "../../lib.ts";
import { includeIndexPages, isRegularFile, readPage, walkMarkdown } from "../derive.ts";
import { fileSource, sidebarOrder } from "../sidebar.ts";
import type { PageIndexEntry } from "./launcher-model.ts";
import { buildPageIndex, type HeadersEnv, sourceHeaders } from "./page-index.ts";

declare const data: PageIndexEntry[];

export { data };

export default {
  async load(): Promise<PageIndexEntry[]> {
    const config = (globalThis as { VITEPRESS_CONFIG?: SiteConfig }).VITEPRESS_CONFIG;
    if (!config) throw new Error("pages.data.ts loads only inside a vitepress build");
    const { srcDir } = config;
    const cleanUrls = config.cleanUrls ?? false;
    // Vite bundles a data loader as CommonJS (the build root carries no
    // package.json declaring ESM), where a static import of vitepress
    // becomes a require() of an ESM-only package; a dynamic import stays.
    const { createMarkdownRenderer } = await import("vitepress");
    const md = await createMarkdownRenderer(
      srcDir,
      config.markdown,
      config.site.base,
      config.logger,
    );
    const site = { base: config.site.base, cleanUrls };
    const files = walkMarkdown(srcDir);
    // The same include roots config.mts read, so the index serves the
    // include pages at the directory URLs the routes do.
    const includes = JSON.parse(process.env.DOCS_SITE_INCLUDES || "[]") as IncludeRoot[];
    const indexPages = includeIndexPages(files, includes);
    return buildPageIndex(
      sidebarOrder(files, fileSource(srcDir, md, site), site, indexPages),
      site,
      {
        title: (file) => readPage(srcDir, file).title,
        headers: (file, relativePath) => {
          const env: MarkdownEnv & HeadersEnv = {
            path: join(srcDir, relativePath),
            relativePath,
            cleanUrls,
          };
          const sourcePath = join(srcDir, file);
          return sourceHeaders(md, readFileSync(sourcePath, "utf-8"), env, {
            file: sourcePath,
            srcDir,
            isFile: isRegularFile,
          });
        },
      },
    );
  },
};
