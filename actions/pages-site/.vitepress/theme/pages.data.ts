// The launcher's page index, built once per site build: every markdown page
// of the docs tree rendered through VitePress's shared markdown-it instance
// for its headings, mapped by page-index.ts, and inlined into the client
// bundle as `data`. Runs only inside a vitepress process, like any data
// loader. Pages render from their source as written, and VitePress expands
// `<!-- @include -->` only in its page transform, so a page that uses the
// directive lists NO heading rows (page-index.ts's sourceHeaders): the
// unexpanded source would shift or collide the anchors after the include,
// and full-text search still reaches those headings.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MarkdownEnv, SiteConfig } from "vitepress";
import { pageTitle, walkMarkdown } from "../derive.ts";
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
    return buildPageIndex(
      walkMarkdown(srcDir),
      { base: config.site.base, cleanUrls },
      {
        title: (file) => pageTitle(srcDir, file),
        headers: (file, relativePath) => {
          const env: MarkdownEnv & HeadersEnv = {
            path: join(srcDir, relativePath),
            relativePath,
            cleanUrls,
          };
          return sourceHeaders(md, readFileSync(join(srcDir, file), "utf-8"), env);
        },
      },
    );
  },
};
