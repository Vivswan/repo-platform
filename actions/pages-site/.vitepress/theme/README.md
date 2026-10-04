# The fleet docs theme

This directory is the ONE home of the fleet's docs-site look: every managed repository's docs site builds with these files, and none of them exists in any fleet repository (fleet repos carry only markdown). Changes here ship on the next `stable` tag move, and every site picks them up on its next deploy (each site's nightly rebuild makes that automatic - no per-repo work).

The base skin is [vitepress-carbon](https://github.com/brenoepics/vitepress-carbon) (GitHub-monochrome, token-based), pinned exact in `../../package.json` next to the exact `vitepress`, `reka-ui`, and `@vueuse/core` pins - all bumped only by deliberate commits here, never by a floating range.

## The customization contract

The component files are written with native CSS nesting: one block per component, `&` where a rule attaches to the block's own element, media blocks kept top-level so a file reads in cascade order.

The build flattens it (Vite minifies CSS with esbuild against its default browser targets), so the shipped stylesheet is flat CSS and every nested rule's specificity is its flattened selector's. Nothing is nested under a selector list, so no `:is()` is introduced.

Each file's header comment and code own its details. The tables say which file to open; the rules after them hold across files.

This directory, `theme/`:

| File | Role |
| --- | --- |
| `tokens.ts` | the fleet token layer as typed data: per-mode and shared tokens, code palette, six hues |
| `tokens-css.ts` | renders `tokens.ts` into the `virtual:fleet-tokens.css` module at build time |
| `base.css` | page-wide rules that have no component of their own |
| `nav.css` | the nav bar and the local nav |
| `sidebar.css` | the sidebar drawer, its groups, and its rows |
| `doc.css` | the doc column's frame: the row above the article, the aside's top, the footer |
| `prose.css` | the article's type |
| `tables.css` | tables and their scroll wrapper |
| `code.css` | code blocks and code-group tabs |
| `mermaid.css` | the mermaid mount and its full-size view |
| `custom-blocks.css` | custom blocks and GitHub alerts |
| `pager.css` | the footer's pager |
| `provenance.css` | the provenance line's look |
| `landing.css` | the landing page's layout: the facts card's aside, the intro's measure |
| `facts.css` | the project facts card's layout |
| `not-found.css` | carbon's not-found page in the fleet's type |
| `print.css` | the print sheet |
| `motion.css` | the reduced-motion stop |
| `image-zoom.css` | the image lightbox's stacking |
| `index.ts` | the theme entry: carbon as base, fonts, mounts, `FleetLauncher` registration (rules below) |
| `tier-routes.ts` | the router guard that makes a cross-tier route a full page load |
| `facts-panel.ts` | the project facts card on landing pages |
| `provenance.ts` | the provenance line: each page's ref, commit, and source file |
| `mermaid.ts` | the diagram component (`MermaidDiagrams`) |
| `mermaid-render.ts` | the render pass over a page's mermaid mounts |
| `mermaid-theme.ts` | mermaid's `themeVariables` from the fleet's tokens |
| `mermaid-zoom.ts` | the Zoom button and the `shown` state the view follows |
| `mermaid-zoom-view.ts` | the full-size diagram view, on Panzoom 4.6.2 (pinned exact) |
| `image-zoom.ts` | the image lightbox (`ImageZoom`), on medium-zoom 1.1.0 (pinned exact) |
| `pages.data.ts` | the launcher's page-and-heading index, built once per site build |
| `page-index.ts` | builds that index; its `headersRule` stamps each page's headings |
| `launcher.ts` | the search launcher component (`FleetLauncher`) |
| `nav-launcher.ts` | the nav's launcher button, its dialog, and the Cmd K, Ctrl K, `/` shortcut |
| `launcher.css` | the launcher's panel, nav button, and dialog |
| `launcher-model.ts` | the launcher's pure model: grouping, folding, matching |
| `launcher-view.ts` | the launcher's pure view helpers |
| `local-search.d.ts` | the type of VitePress's `@localSearchIndex` virtual module |
| `css.d.ts` | the type stand-in for CSS imports |

The parent directory, `.vitepress/`:

| File | Role |
| --- | --- |
| `../config.mts` | site structure, the `DOCS_SITE_*` env contract, the facts contract, the markdown rules |
| `../landing-table.ts` | turns the landing page's link table into the `FleetLauncher` panel |
| `../inline-text.ts` | stamps plain text on every inline token |
| `../rewrite-links.ts` | resolves relative links in repository space, as they read on GitHub |
| `../table-wrap.ts` | wraps each top-level table in its scroll wrapper |
| `../mermaid.ts` | the mermaid fence rule: a fence becomes a mount |
| `../custom-blocks.ts` | custom-block titles in sentence case, and `alertTitlesRule` |
| `../anchors.ts` | heading ids as GitHub assigns them |
| `../version-nav.ts` | the version menu |
| `../source-path.ts` | a staged page's repository path, and the landing-file test |
| `../derive.ts` | routes, locales, and the per-page read from the docs tree |
| `../sidebar.ts` | the sidebar and its order |
| `../dir-title.ts` | a directory's display title |
| `../conventions.ts` | docs conventions shared by the site build and the plan action |
| `../url-path.ts` | URL path and file path conversion, segment by segment |

Rules a change keeps:

- **Carbon is never edited:** a palette change is a set of values in `tokens.ts`, and a new hue is an entry in `HUES`, never a hex elsewhere.
- **Reading rules:** running prose at line-height 1.65 or more, left-aligned, emphasis by weight (never italics), sentence-case labels, the hue as the only accent. `prefers-reduced-motion` stays honored.
- **Import order:** `print.css` is imported after every component file, so its overrides win ties, and `motion.css` last. `motion.css` holds the theme's only `!important` rules.
- **`index.ts` keeps its mounts:** it exports a VitePress `Theme` with three slot mounts (`NavLauncher` in `nav-bar-content-before`, `FactsPanel` in `aside-top`, `Provenance` in `doc-after`). `MermaidDiagrams` and `ImageZoom` render BESIDE carbon's `Layout`, since the doc slots skip a `layout: page` or `home` page and `layout: false` skips every slot.
- **`index.ts` keeps its wiring:** `ctx.app.component("FleetLauncher", ...)`, since the landing-table rule emits that tag and an unregistered tag renders empty. The `@fontsource-variable` fonts are self-hosted and imported before the CSS; remote font links are banned.
- **`index.ts` in the browser:** it stamps `data-fleet-hue` on `<html>` when the attribute is missing, for `vitepress dev`, and installs `tier-routes.ts`'s guard as `ctx.router.onBeforeRouteChange`.
- **Seven markdown rules:** `../config.mts`'s `markdown.config` installs, in this order, `inlineTextRule`, `rewriteLinksRule`, `landingTableRule`, `tableWrapRule`, `headersRule`, `alertTitlesRule`, `mermaidRule`. Keep all seven: the page index's header reader throws without `headersRule`, and without the others source-file links, tables, alerts, labels and diagram fences render unprocessed.
- **Links from a fleet repository:** without `rewriteLinksRule`, a link from `<repo>/docs/` to `<repo>/README.md` or `<repo>/.github/workflows/ci.yml` renders as `README.html` or `<repo>/.github/...` and 404s on the site while passing VitePress's dead-link check. `<repo>` is the fleet repository's root.
- **The env contract:** adjust `themeConfig` freely, but the `DOCS_SITE_*` env contract at the top of `../config.mts` belongs to the pages-site action. `../version-nav.ts` keeps reading `DOCS_SITE_VERSIONS`, `DOCS_SITE_CURRENT`, and `DOCS_SITE_ORIGIN`.
- **Listbox, not Combobox:** the launcher panel is always mounted, and reka-ui's Combobox content aria-hides the rest of the page while mounted.
- **Dialogs are modal through reka-ui:** the diagram view and the search dialog get the focus trap, Escape, the body scroll lock, `aria-hidden` on the rest of the page, and focus back on close.
- **Launcher states:** each has a non-color cue at 3:1 or better against the panel; matches are bold, never colored.
- **A new mermaid text surface** adds its pair to `theme_contrast.test.ts`, which lists the pairs by hand.
- **The launcher's data and rules:** `pages.data.ts` keeps exporting `data: PageIndexEntry[]`, which the launcher reads. Grouping, folding, and matching rules change in `launcher-model.ts`, never in the component.
- **The sidebar's ordering rule** is documented for fleet authors in `docs/site.md` (Docs conventions); change `../sidebar.ts` and that page together.
- **Anchors:** changing `../anchors.ts`'s algorithm changes every site's anchors at once.
- **`local-search.d.ts` is hand-written:** a VitePress bump is checked against the local-search plugin's `load()` output by hand.

Tests that guard the theme (each file owns its scenarios):

| Test | Guards |
| --- | --- |
| `theme_contrast.test.ts` | every text and code token, and every mermaid text variable, at 4.5:1 on its ground |
| `theme_tokens.test.ts` | the rendered token layer against `tokens.ts`, and a var() reader per token |
| `theme_layout.test.ts` | the diagram view and the image lightbox in headless Chrome |
| `mermaid_labels.test.ts` | every mermaid label inside its box, in headless Chrome |
| `mermaid_render.test.ts` | no mermaid download without a mount; no reka-ui or vueuse in the render pass's import graph |
| `tier_routes.test.ts` | the tier guard, which stays pure and browser-free |
| `tests/ci/pages_site_build` | no page references the mermaid chunk |

The first six live in `tests/actions/pages-site/`.

## The VitePress 2 path (deferred deliberately)

`vitepress` stays on the 1.6 line because carbon@1.6.0 declares no VitePress 2 compatibility. When VitePress 2 goes stable, there are two moves:

- **Carbon has ported:** bump both pins together.
- **A token port:** reimplement carbon's `vars.css` values over VitePress's default theme in this directory. The file layout and the contract above are built so that swap stays local to this directory plus `../config.mts`'s `extends`/theme imports.

## Content rules

- Fleet docs are plain `.md` only - no MDX and no per-repo Vue components. Rich widgets are added HERE, as theme-provided [markdown containers](https://vitepress.dev/guide/markdown#custom-containers) or globally registered components, so every repository gets them for free.
- Translations follow one convention: `docs/<lang>[-<region>]/` (a two-letter ISO 639-1 code, e.g. `zh-cn/`, `ja/`) mirroring the root structure. Detected directories become VitePress locales with the language switcher in the nav (carbon ships the translations menu); the root tree is the default (English) locale. The detection rule lives in `../derive.ts`.
- The dropdown navigates to a version's ROOT, not the same page in the other version - page sets differ across versions, so deep cross-version links are not guaranteed to exist.
