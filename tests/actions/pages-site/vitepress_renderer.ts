// VitePress's shared markdown renderer with the fleet's rules, as
// config.mts installs them, for tests that need VitePress's own parse (its
// containers, its link normalization). createMarkdownRenderer keeps one
// instance per process, so every test file goes through this one helper
// and its one set of options.

import { join, resolve } from "node:path";
import { githubSlug, headingText } from "../../../actions/pages-site/.vitepress/anchors.ts";
import {
  alertTitlesRule,
  CUSTOM_BLOCK_LABELS,
} from "../../../actions/pages-site/.vitepress/custom-blocks.ts";
import { inlineTextRule } from "../../../actions/pages-site/.vitepress/inline-text.ts";
import { landingTableRule } from "../../../actions/pages-site/.vitepress/landing-table.ts";
import { mermaidRule } from "../../../actions/pages-site/.vitepress/mermaid.ts";
import { rewriteLinksRule } from "../../../actions/pages-site/.vitepress/rewrite-links.ts";
import { headersRule } from "../../../actions/pages-site/.vitepress/theme/page-index.ts";

export type Md = Parameters<typeof landingTableRule>[0];

export const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");

/** A docs tree indexed by READMEs at the root and in ja/, with a guide/
 *  directory that carries both spellings (its README keeps its own route). */
export const REWRITES = { "README.md": "index.md", "ja/README.md": "ja/index.md" };

/** The site the renderer writes links for. */
export const SITE = { base: "/repo/", cleanUrls: false };

/** The repository the docs tree comes from, for links that leave it. */
export const LINK_SCOPE = {
  docsDir: "docs",
  includes: [],
  rewrites: REWRITES,
  repoUrl: "https://github.com/fixture-owner/fixture-repo",
  ref: "main",
};

export async function vitepressRenderer(): Promise<Md> {
  const vitepress = (await import(
    join(ACTION_DIR, "node_modules", "vitepress", "dist", "node", "index.js")
  )) as {
    createMarkdownRenderer(srcDir: string, options: object, base: string): Promise<Md>;
  };
  return vitepress.createMarkdownRenderer(
    ACTION_DIR,
    {
      highlight: () => "",
      anchor: { slugify: githubSlug, getTokensText: headingText },
      headers: { level: [2, 3] },
      container: CUSTOM_BLOCK_LABELS,
      config(md: Md) {
        inlineTextRule(md);
        rewriteLinksRule(md, LINK_SCOPE);
        landingTableRule(md, REWRITES);
        headersRule(md);
        alertTitlesRule(md);
        mermaidRule(md);
      },
    },
    SITE.base,
  );
}
