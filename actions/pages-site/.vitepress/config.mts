// The central VitePress config every fleet docs site builds with. The
// caller repository contributes its markdown tree plus the repo-level facts
// (copier answers, toolchain pins, LICENSE.md) the action reads from the
// tier's git tree; everything here is driven by the environment the
// pages-site action sets per tier (build.ts owns that contract):
//
//   DOCS_SITE_SRC           the docs tree to render (required)
//   DOCS_SITE_TITLE         site title
//   DOCS_SITE_BASE          URL base path for this tier
//   DOCS_SITE_VERSIONS      JSON [{label, link}] for the version dropdown
//   DOCS_SITE_CURRENT       this tier's version label
//   DOCS_SITE_FACTS         JSON ProjectFacts (facts.ts) for the theme's
//                           facts card, provenance line, and per-repo hue
//                           (required)
//   DOCS_SITE_EDIT_PATTERN  editLink pattern (set only where editing the
//                           source can change THIS content: latest tiers)
//   DOCS_SITE_IGNORE_DEAD_LINKS  "1" on historical tag tiers only: dead
//                           internal links are fatal on current content
//                           (that failure is the docs PR check's value),
//                           but history cannot be fixed

import { defineConfigWithTheme } from "vitepress";
import type { ThemeConfig } from "vitepress-carbon";
// Carbon's base config wires the theme package into vite (alias, optimize
// lists, the llms.txt plugin); the deep import is the path its own demo
// documents.
import baseConfig from "vitepress-carbon/dist/theme/config/baseConfig.js";
import type { ProjectFacts } from "../facts.ts";
import { deriveRewrites, deriveSidebar, detectLocales, walkMarkdown } from "./derive.ts";

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
const versions = JSON.parse(process.env.DOCS_SITE_VERSIONS || "[]") as {
  label: string;
  link: string;
}[];
const facts = JSON.parse(required("DOCS_SITE_FACTS")) as ProjectFacts;

// Locales by convention alone: docs/<lang>[-<region>]/ mirroring the root
// structure IS a locale (derive.ts owns the detection rule); the root tree
// is the default (English) locale. Detected per build, so a tagged
// version's translations are that tag's own.
const localeDirs = detectLocales(files);
const rootFiles = files.filter((file) => !localeDirs.includes(file.split("/")[0]));
const nativeName = (tag: string): string => {
  try {
    const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag);
    return name && name !== tag ? name : tag;
  } catch {
    return tag;
  }
};

const sidebar: NonNullable<ThemeConfig["sidebar"]> = { "/": deriveSidebar(srcDir, rootFiles) };
const locales: Record<string, { label: string; lang: string }> = {
  root: { label: "English", lang: "en" },
};
for (const dir of localeDirs) {
  locales[dir] = { label: nativeName(dir), lang: dir };
  sidebar[`/${dir}/`] = deriveSidebar(
    srcDir,
    files.filter((file) => file.startsWith(`${dir}/`)),
    `${dir}/`,
  );
}

export default defineConfigWithTheme<FleetThemeConfig>({
  extends: baseConfig,
  title: process.env.DOCS_SITE_TITLE || "Documentation",
  base: process.env.DOCS_SITE_BASE || "/",
  srcDir,
  locales,
  rewrites: deriveRewrites(files),
  ignoreDeadLinks: process.env.DOCS_SITE_IGNORE_DEAD_LINKS === "1",
  // No lastUpdated: every tier builds from a materialized copy of the docs
  // tree (never a git checkout - see buildVitepressTier), so git-derived
  // timestamps do not exist by construction.
  vite: {
    css: {
      postcss: {
        plugins: [
          {
            // Carbon's utils.css imports Google Fonts and cdnfonts; postcss-import
            // hoists remote @imports untouched, so without this every page of
            // every fleet site would call two third-party hosts on load. The
            // bundled Mona Sans is a local url(), not an @import, and stays.
            postcssPlugin: "fleet-drop-remote-imports",
            AtRule: {
              import(rule) {
                if (/^(url\(\s*)?["']?https?:/.test(rule.params)) rule.remove();
              },
            },
          },
        ],
      },
    },
  },
  // VitePress defaults the custom-block titles to uppercase (TIP, WARNING);
  // the fleet theme reads them in sentence case.
  markdown: {
    container: {
      infoLabel: "Info",
      noteLabel: "Note",
      tipLabel: "Tip",
      warningLabel: "Warning",
      dangerLabel: "Danger",
      detailsLabel: "Details",
      importantLabel: "Important",
      cautionLabel: "Caution",
    },
  },
  // Landing pages (README.md, rewritten to index.md at any depth) are the
  // site's front matter, not an article: the theme lays them out from the
  // flag and they carry no outline.
  transformPageData(pageData) {
    if (!/(^|\/)index\.md$/.test(pageData.relativePath)) return;
    return { frontmatter: { ...pageData.frontmatter, fleetLanding: true, outline: false } };
  },
  transformHtml(code) {
    return code.replace("<html", `<html data-fleet-hue="${facts.hue}"`);
  },
  themeConfig: {
    nav: [],
    sidebar,
    search: { provider: "local" },
    outline: "deep",
    ...(process.env.DOCS_SITE_EDIT_PATTERN
      ? { editLink: { pattern: process.env.DOCS_SITE_EDIT_PATTERN, text: "Edit this page" } }
      : {}),
    docsSiteVersions: versions,
    docsSiteCurrent: process.env.DOCS_SITE_CURRENT || "",
    docsSiteFacts: facts,
  },
});
