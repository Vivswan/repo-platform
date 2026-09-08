// The launcher's page index, built once per site build: every markdown page
// of the docs tree rendered through VitePress's shared markdown-it instance
// for its headings, mapped by page-index.ts, and inlined into the client
// bundle as `data`. Runs only inside a vitepress process, like any data
// loader. Pages are rendered from their source as written: VitePress's
// `<!-- @include -->` expansion is internal to its page transform, so an
// included file's headings are not indexed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMarkdownRenderer, type MarkdownEnv, type SiteConfig } from "vitepress";
import { pageTitle, walkMarkdown } from "../derive.ts";
import type { PageIndexEntry } from "./launcher-model.ts";
import { buildPageIndex, type HeadersEnv, renderedHeaders } from "./page-index.ts";

declare const data: PageIndexEntry[];

export { data };

export default {
  async load(): Promise<PageIndexEntry[]> {
    const config = (globalThis as { VITEPRESS_CONFIG?: SiteConfig }).VITEPRESS_CONFIG;
    if (!config) throw new Error("pages.data.ts loads only inside a vitepress build");
    const { srcDir } = config;
    const cleanUrls = config.cleanUrls ?? false;
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
          md.render(readFileSync(join(srcDir, file), "utf-8"), env);
          return renderedHeaders(env);
        },
      },
    );
  },
};
