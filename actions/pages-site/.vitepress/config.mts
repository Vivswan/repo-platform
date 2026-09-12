// Every fleet docs site builds with this config; the pages-site action sets the environment per tier (build.ts owns that contract).
//
//   DOCS_SITE_SRC                the docs tree to render
//   DOCS_SITE_TITLE              site title
//   DOCS_SITE_BASE               URL base path for this tier
//   DOCS_SITE_VERSIONS           JSON [{label, link}] for the version dropdown
//   DOCS_SITE_CURRENT            this tier's version label
//   DOCS_SITE_FACTS              JSON ProjectFacts (facts.ts)
//   DOCS_SITE_INCLUDES           JSON IncludeRoot[] (lib.ts), the other roots staged inside the docs tree
//   DOCS_SITE_EDIT_BASE          the repository's edit URL up to the repo root; set only where editing can change THIS content
//   DOCS_SITE_IGNORE_DEAD_LINKS  "1" on historical tag tiers only: dead internal links are fatal on current content, but history cannot be fixed

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCssVariablesTheme, normalizeTheme } from "shiki";
import { createMarkdownRenderer, defineConfigWithTheme, type MarkdownOptions } from "vitepress";
import type { ThemeConfig } from "vitepress-carbon";
// Carbon's base config wires the theme package into vite (alias, optimize
// lists, the llms.txt plugin); the deep import is the path its own demo
// documents.
import baseConfig from "vitepress-carbon/dist/theme/config/baseConfig.js";
import type { ProjectFacts } from "../facts.ts";
import type { IncludeRoot } from "../lib.ts";
import { githubSlug, headingText } from "./anchors.ts";
import { alertTitlesRule, CUSTOM_BLOCK_LABELS } from "./custom-blocks.ts";
import { deriveRewrites, includeIndexPages, untitledPageTitle, walkMarkdown } from "./derive.ts";
import { inlineTextRule } from "./inline-text.ts";
import { landingTableRule } from "./landing-table.ts";
import { mermaidRule } from "./mermaid.ts";
import { rewriteLinksRule } from "./rewrite-links.ts";
import { deriveSidebar, fileSource, sidebarTrees } from "./sidebar.ts";
import { isLandingFile, sourcePathOf } from "./source-path.ts";
import { tableWrapRule } from "./table-wrap.ts";
import { headersRule } from "./theme/page-index.ts";

/** Carbon's theme config plus the fleet keys the version switcher and the
 *  facts surfaces read. Optional, so carbon's own baseConfig (typed
 *  against plain ThemeConfig) stays assignable in `extends`. */
interface FleetThemeConfig extends ThemeConfig {
  docsSiteVersions?: { label: string; link: string }[];
  docsSiteCurrent?: string;
  docsSiteFacts?: ProjectFacts;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set - this config only runs under the pages-site action`);
  }
  return value;
}

const srcDir = required("DOCS_SITE_SRC");
const files = walkMarkdown(srcDir);
const includes = JSON.parse(process.env.DOCS_SITE_INCLUDES || "[]") as IncludeRoot[];
const indexPages = includeIndexPages(files, includes);
const rewrites = deriveRewrites(files, indexPages);
const versions = JSON.parse(process.env.DOCS_SITE_VERSIONS || "[]") as {
  label: string;
  link: string;
}[];
const facts = JSON.parse(required("DOCS_SITE_FACTS")) as ProjectFacts;
const title = process.env.DOCS_SITE_TITLE || "Documentation";
const base = process.env.DOCS_SITE_BASE || "/";
const editBase = process.env.DOCS_SITE_EDIT_BASE || "";
// An icon link only for an icon the docs tree ships (VitePress serves
// public/ at the base): a link to a missing file would be a 404 on every
// page, while no link lets the browser fall back to the site's favicon.ico.
const icon = ["favicon.svg", "favicon.ico"].find((name) =>
  existsSync(join(srcDir, "public", name)),
);

// Locales by convention alone: docs/<lang>[-<region>]/ mirroring the root
// structure IS a locale (derive.ts owns the detection rule); the root tree
// is the default (English) locale. Detected per build, so a tagged
// version's translations are that tag's own.
const nativeName = (tag: string): string => {
  try {
    const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag);
    return name && name !== tag ? name : tag;
  } catch {
    return tag;
  }
};

const markdown: MarkdownOptions = {
  // Heading ids are GitHub's (anchors.ts): the fleet writes its links for
  // the README on GitHub, and the headers plugin reads the anchor's id.
  anchor: { slugify: githubSlug, getTokensText: headingText },
  // The code palette is custom properties the theme's tokens.ts owns per mode (--fleet-code-*), so token
  // contrast is a token value the contrast test can guard, not a hex baked into every span. Normalized once
  // here because shiki normalizes a raw theme on every fence and mutates its colors in place; the second
  // pass then loses the ansi var() mapping and an ansi fence prints in the placeholder hex.
  theme: normalizeTheme(
    createCssVariablesTheme({
      name: "fleet",
      variablePrefix: "--fleet-code-",
      // No italics: the fleet reads emphasis by weight.
      fontStyle: false,
    }),
  ),
  config(md) {
    inlineTextRule(md);
    // Before the landing rule, so the curated table's hrefs are the routes
    // its rows attach to.
    rewriteLinksRule(md, {
      docsDir: facts.docsDir,
      includes,
      files,
      rewrites,
      base,
      repoUrl: facts.repoUrl,
      ref: facts.provenance.label,
    });
    landingTableRule(md, rewrites);
    // After the landing rule: the launcher replaces its table's tokens, so
    // the panel gets no scroll wrapper (and no wrapper tab stop before its
    // combobox). VitePress installs its own table_open renderer between
    // preConfig and config, so the wrapper's rule must land here to move the
    // tab stop from the table to the wrapper.
    tableWrapRule(md);
    headersRule(md);
    alertTitlesRule(md);
    mermaidRule(md);
  },
  container: CUSTOM_BLOCK_LABELS,
};

// The sidebar reads each landing page through VitePress's renderer, so the
// config is async. createMarkdownRenderer keeps one instance per process:
// the one made here is the one the pages render with, so it gets the
// options VitePress would resolve, carbon's (its header levels) under ours.
export default async () => {
  const md = await createMarkdownRenderer(srcDir, { ...baseConfig.markdown, ...markdown }, base);
  const source = fileSource(srcDir, md, { base, cleanUrls: false });
  const sidebar: NonNullable<ThemeConfig["sidebar"]> = {};
  const locales: Record<string, { label: string; lang: string }> = {
    root: { label: "English", lang: "en" },
  };
  for (const tree of sidebarTrees(files)) {
    sidebar[`/${tree.prefix}`] = deriveSidebar(
      tree.files,
      source,
      { base, cleanUrls: false },
      {
        prefix: tree.prefix,
        siteTitle: title,
        indexPages,
      },
    );
    if (tree.prefix === "") continue;
    const dir = tree.prefix.slice(0, -1);
    locales[dir] = { label: nativeName(dir), lang: dir };
  }

  return defineConfigWithTheme<FleetThemeConfig>({
    extends: baseConfig,
    title,
    description: facts.description ?? title,
    head: icon === undefined ? [] : [["link", { rel: "icon", href: `${base}${icon}` }]],
    base,
    srcDir,
    locales,
    rewrites,
    ignoreDeadLinks: process.env.DOCS_SITE_IGNORE_DEAD_LINKS === "1",
    // No lastUpdated: every tier builds from a materialized copy of the docs
    // tree (never a git checkout - see buildVitepressTier), so git-derived
    // timestamps do not exist by construction.
    vite: {
      css: {
        postcss: {
          plugins: [
            {
              // Carbon's utils.css ships fonts nothing selects once tokens.css sets the families, so both are dropped here.
              //   @import of Google Fonts and cdnfonts  -> two third-party calls per page load
              //   the bundled Mona Sans @font-face      -> carbon's transformHead preloads it, 137 KB per page
              // A Once hook, not AtRule visitors: vite emits url() assets from its own Once hook, and PostCSS runs every Once before any visitor.
              postcssPlugin: "fleet-drop-carbon-fonts",
              Once(root) {
                root.walkAtRules("import", (rule) => {
                  if (/^(url\(\s*)?["']?https?:/.test(rule.params)) rule.remove();
                });
                root.walkAtRules("font-face", (rule) => {
                  rule.walkDecls("font-family", (decl) => {
                    if (/^["']?Mona Sans["']?$/.test(decl.value)) rule.remove();
                  });
                });
              },
            },
          ],
        },
      },
    },
    markdown,
    // filePath becomes the page's REPOSITORY path (docs/guide/README.md): the edit link's `:path` and the
    // provenance line read it, and nothing on the node side reads it after this hook. A page with neither
    // a title key nor an h1 is titled the way derive.ts titles its sidebar row, so the two agree.
    //   README.md or index.md at any depth  -> fleetLanding, no outline: the theme lays it out as front matter, not an article
    //   an include root's page              -> serves at its directory URL too, but stays an article
    transformPageData(pageData) {
      const source = {
        filePath: sourcePathOf(facts.docsDir, includes, pageData.filePath),
        ...(pageData.title === ""
          ? { title: untitledPageTitle(pageData.filePath, pageData.frontmatter.name) }
          : {}),
      };
      if (!isLandingFile(pageData.filePath)) return source;
      return {
        ...source,
        frontmatter: { ...pageData.frontmatter, fleetLanding: true, outline: false },
      };
    },
    transformHtml(code) {
      return code.replace("<html", `<html data-fleet-hue="${facts.hue}"`);
    },
    themeConfig: {
      nav: [],
      sidebar,
      search: { provider: "local" },
      outline: "deep",
      // carbon's default title is uppercase; the fleet reads sentence case
      notFound: { title: "Page not found", linkText: "Go to the front page" },
      docFooter: { prev: "Previous", next: "Next" },
      // The translations menu goes to a locale's landing page, never to
      // "the same page" there: a translation tree lags the root, and the
      // corresponding page's URL is a 404 wherever it does.
      i18nRouting: false,
      // Carbon 1.6.0's Markdown menu prefixes the site base twice (route.path
      // already carries it, then withBase()), so on every based fleet site its
      // fetch 404s; llms.txt, from the same plugin, is unaffected and ships.
      llms: { pageActions: false },
      // `:path` is the page's repository path (transformPageData above), so
      // the edit base ends at the repository root.
      ...(editBase ? { editLink: { pattern: `${editBase}:path`, text: "Edit this page" } } : {}),
      docsSiteVersions: versions,
      docsSiteCurrent: process.env.DOCS_SITE_CURRENT || "",
      docsSiteFacts: facts,
    },
  });
};
