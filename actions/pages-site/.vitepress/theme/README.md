# The fleet docs theme

This directory is the ONE home of the fleet's docs-site look: every managed repository's docs site builds with these files, and none of them exists in any fleet repository (fleet repos carry only markdown). Changes here ship on the next `stable` tag move, and every site picks them up on its next deploy (each site's nightly rebuild makes that automatic - no per-repo work).

The base skin is [vitepress-carbon](https://github.com/brenoepics/vitepress-carbon) (GitHub-monochrome, token-based), pinned exact in `../../package.json` next to the exact `vitepress`, `reka-ui`, and `@vueuse/core` pins - all bumped only by deliberate commits here, never by a floating range.

## The customization contract

The component files are written with native CSS nesting: one block per component, `&` where a rule attaches to the block's own element, media blocks kept top-level so a file reads in cascade order.

The build flattens it (Vite minifies CSS with esbuild against its default browser targets), so the shipped stylesheet is flat CSS and every nested rule's specificity is its flattened selector's. Nothing is nested under a selector list, so no `:is()` is introduced.

Each file below opens with what it controls; the bullets after it say what to keep when changing it.

### `tokens.ts`

The fleet TOKEN LAYER as typed data:

- **Per-mode tokens (`MODE_TOKENS`):** carbon's `--vp-*` custom properties set to the fleet's values, light and dark, plus the print sheet's overrides. They cover grounds, text tiers, dividers, code, custom blocks, buttons, the shadow steps carbon reads, and nav and sidebar metrics.
- **Shared tokens (`SHARED_TOKENS`):** the tokens with one value in every mode, written on `:root` and `.dark` both so carbon's own `.dark` values lose. They are the self-hosted font stacks, radii, the transition, the reading measure, the layout metrics with their media overrides, and the functional aliases that read the hue and the grounds, one `--color-<kind>` per custom-block kind among them.
- **Layout metrics among the shared tokens:** the sidebar token narrows from 320px to 280px between 768px and carbon's 1280px aside breakpoint, where the sidebar shares the width with the article alone. `--fleet-gutter` is the margin each side of the 1440px frame on a wider viewport, 0 below it, and every rule that offsets something into the frame reads it.
- **The code palette (`--fleet-code-*`):** the variables the shiki theme `../config.mts` installs colors every token with, so no highlighter hex is baked into a page.
- **The hues (`HUES`):** the six per-repository hues (slot N is `data-fleet-hue="N"`) with their light and dark values.

To change it:

- **Never edit carbon:** carbon's design system is `--vp-*` custom properties (the authoritative token list is `packages/theme/src/theme/styles/vars.css` in carbon's repo), so a palette change is a set of values here.
- **Color reads the hue:** everything that carries color reads `--fleet-hue`, except the warning and caution blocks, which read their own `--color-warning` and `--color-caution`. Add a hue by adding an entry to `HUES`, never by writing a hex elsewhere.
- **Contrast:** every text and code token is contrast-tested against its ground per mode (`tests/actions/pages-site/theme_contrast.test.ts`); a new value must clear 4.5:1 there.
- **Readers:** every declared token must have a var() reader (`theme_tokens.test.ts`).
- **Nothing to regenerate:** `tokens-css.ts` renders this data at build time.

### `tokens-css.ts`

Renders `tokens.ts` into the token layer at build time. `../config.mts` installs its Vite plugin, which serves the render as `virtual:fleet-tokens.css`. The render holds:

- the shared block on `:root, .dark` with its media overrides
- the `:root` (light) and `.dark` palettes
- the `html[data-fleet-hue="N"]` / `html.dark[data-fleet-hue="N"]` hue blocks
- the print palette on `html:root` inside `@media print`, which outranks the mode and hue blocks, so it comes last

To change it:

- **No file holds the CSS:** `index.ts` imports the virtual module first, before the component rules, so every rule reads the fleet's values.
- **Pinned:** `theme_tokens.test.ts` pins the render against the data.

### `base.css`

Page-wide rules: scroll padding under the nav, the 17px body type at line-height 1.7 (16px below 768px), left-aligned text, the hue on selection, the focus ring, thin scrollbars in the scroll token.

- **Focus rings** are outline plus offset only; a component that wants a rounded ring sets its own radius. An inline link's ring sits at 1px so it clears the neighbouring words.
- **What belongs here:** a rule only when it has no component to live in.

### `nav.css`

The nav bar and the local nav: the appearance switch inline at every width, the "..." flyout and the hamburger hidden when they would hold nothing else, the title column and the controls on the frame's edges, the flyouts' material, and the local nav's 44px controls and outline sheet. Carbon shows the local nav below its 1280px aside breakpoint.

- **The appearance switch:** carbon parks it in the "..." flyout until 1280px and in the hamburger's screen below 768px. The rules here show it inline and hide that flyout when nothing else would be in it.
- **The hamburger** hides when its screen would hold nothing but the switch. A site with nav items (the version menu among them), locales, or social links keeps it.
- **Locales:** between 768px and 1279px a site with locales therefore shows the switch before the language flyout, since carbon keeps translations in that flyout there.
- **Wide viewports:** on a viewport wider than the frame the nav's title and controls sit on the frame's edges (`--fleet-gutter`, the same value carbon offsets the article by).
- **The brand's focus ring** sits on its pill, not the 60px link.
- **Menu links:** carbon's menu links never pass `noIcon` on, so the rules here drop the external-link glyph from menu links (the version menu's are absolute URLs).

### `sidebar.css`

The sidebar: the drawer's width and shadow, the group's width, the row (hover tint, active band, focus ring on one box), group heads by weight, nested lists indented only under a visible head.

- **The width is the token:** the sidebar's width is the `--vp-sidebar-width` token. The rules here lift carbon's 230px drawer cap, so the desktop sidebar is the token and the mobile drawer is `min(100vw - 64px, token)`, and let the group take the nav's inner width. Widen the token, never a rule here.
- **Specificity:** every rule carries the `.nav .group` ancestors because carbon's per-level rules reach seven class-levels once scoped. `:root .Layout .VPSidebar` outranks carbon's own dark-mode shadow rule.
- **The row** (not the link inside it) carries hover, the active band and the focus ring.
- **The opened drawer** takes focus without a ring and casts `--vp-shadow-3` in both modes.
- **A group head** (a directory, or pages sharing a frontmatter `group`) is the row without a link, set in weight 500.

### `doc.css`

The doc column's frame: the row above the article (the Edit link alone, right-aligned, as a 32px icon button), the aside's top level with the h1, the outline's type and active marker, the footer's spacing.

- **One row height:** the row above the article is one height, `--fleet-content-top-height` on `.VPDoc`, that the aside's top and the landing card's top read to sit level with the h1. It is kept on a page without an edit link too.
- **Breadcrumb:** carbon's breadcrumb (which repeated the h1) is hidden.
- **Markdown menu:** carbon's Markdown menu is switched off in `../config.mts` because its fetch path carries the site base twice and 404s on every based site.
- **Edit label:** the Edit control's label stays in the DOM as its accessible name.

### `prose.css`

The article's type: headings in the display face, running prose, lists, links, blockquotes, rules, images, inline code, highlights, keycaps, and the phone sizes.

- **Reading rules hold:** running prose at line-height 1.65 or more, left-aligned, emphasis by weight (never italics), sentence-case labels, the hue as the only accent.
- **Inline code** is an atomic inline: whole, or wrapped inside only when wider than its column. It uses `break-word`, not `anywhere`, so a prose column never starves a code column.
- **In a table's scroll wrapper** a token counts whole up to half the wrapper (`50cqi`; the wrapper is the size container) and wraps inside past it, so a long token never leaves its prose neighbour a column of single words.
- **Phones:** below 768px the body and the article run at 16px and the h1 at 31px (28px below 430px).

### `tables.css`

Tables: the scroll wrapper `../table-wrap.ts` emits as the horizontal scroller at every width with an edge shadow toward the hidden side, the hairline rows, the 13.5px heads, inline-code tokens whole in cells up to half the wrapper.

- **Scroll, not towers:** a table scrolls in its wrapper rather than wrapping its cells into towers. What makes a table wider is its columns' natural widths: an inline-code token counts whole up to `prose.css`'s cap, prose as its longest word.
- **The cap** keeps ONE long code column from starving its prose neighbour. Two or more long code columns beside prose can still take the wrapper between them and leave the prose its longest word (recorded, unbuilt).
- **The container:** the wrapper is the `container-type: inline-size` container that cap is measured against.
- **Phones:** below 768px a table may spread to twice the column before its cells wrap, and heads sit at 14px, the floor for informational text on a phone.
- **Nested tables:** a table nested in a quote or list has no wrapper and keeps carbon's own scrolling block.

### `code.css`

Code blocks: a bordered panel with a control row above the code (the language label and the copy button in the pre's top padding), the tables' edge shadows and thumb on overflow, the focus ring drawn by the block, the code-group tabs.

- **The control row's height** is `--fleet-codeblock-top`, shared by the pre and its line-number gutter (the print sheet shrinks it).
- **Touch screens:** the copy button is always shown at a 36px target and shares the row with the label.
- **The radius** holds at every width: the block never reaches the viewport edge.
- **Phones:** below 768px the language label sits at 14px.

### `mermaid.css`

The mermaid mount and its full-size view:

- **The mount** (`fleet-mermaid`, from `../mermaid.ts`): a code-ground panel in the block radius that scrolls sideways when a diagram is wider than the column. Inside it sit the source `pre` in the code type, the rendered SVG centered and scaled down to the column, the error line under the source, and the Zoom button over the panel's corner.
- **The full-size view** (`fleet-mermaid-view`, reka-ui's Dialog content from `mermaid-zoom-view.ts`): the whole viewport, a control bar over a stage the reader drags and zooms. The bar wraps on a narrow viewport, so no button shrinks under its label.

To change it:

- **`data-state` drives what shows:** the mount's `data-state` (`rendered`, `error`, set by `mermaid-render.ts`) shows the source until the diagram renders and beside an error, and the diagram alone once rendered.
- **Label line-height:** a paragraph inside the diagram keeps the line-height mermaid measured it with. Mermaid sizes each html label's `foreignObject` on `<body>`, so an article paragraph rule reaching the drawn label clips its last line. `tests/actions/pages-site/mermaid_labels.test.ts` holds every label inside its box in headless Chrome.
- **The Zoom button:** with a pointer that hovers, it shows on hover and focus-within; a touch screen always shows it.
- **The view's layer:** fixed over the nav and the sidebar as the launcher's dialog is. Reka-ui locks the page's scroll while it is open, and Panzoom owns the stage's cursor, overflow and touch-action inline.
- **No motion:** nothing in the view transitions, so `motion.css` has nothing to stop.
- **Print:** the print sheet keeps the mount whole on one page, drops the Zoom button and the view, drops its ground as it does for code blocks, and wraps the source. From the dark appearance it prints the source in the diagram's place: the SVG's colors are baked for the screen mode, and chalk labels on white paper would not read.

### `custom-blocks.css`

Custom blocks (`::: tip`, `::: warning`, GitHub alerts): one panel material, the kind named by its title text and by its `--color-<kind>` token on the 2px rule.

- **A risk reads apart from a hint:** note, tip, important, info and details carry the hue with the title in the ink. Warning and caution (and the `::: danger` container, GitHub's CAUTION) color the title too, so a risk reads apart from a hint at a glance while the body stays the ink.
- **The kind tokens** are `tokens.ts`'s `SHARED_TOKENS.customBlocks` and `MODE_TOKENS.alerts`.

### `pager.css`

The footer's pager: two quiet links under one hairline, the whole link as the hit target, label, title and arrow at rest, the hue on the arrow and a band tint on the link only on hover and focus, and the stacked phone layout.

- **Never cards.**
- **Flush text:** the links' padding is pulled outside the column with a matching negative margin, so the text stays flush with the article and the tint spills past it the way a hovered list row does.
- **A hovered label** lifts to the secondary ink because the tertiary ink sits under 4.5:1 on the tint (`theme_contrast.test.ts`).
- **Phones:** below 768px the next link keeps its right alignment and the label sits at 14px.

### `provenance.css`

The provenance line (`provenance.ts`): a 12.5px mono caption in the tertiary ink under its own hairline, its links underlined in the border color.

- **After a pager** the line is the footer's last row: it drops its rule and top padding, so the footer ends in one ruled band rather than three.
- **Phones:** below 768px it sits at 14px.

### `landing.css`

The landing page's layout: a wider, static aside for the facts card (`--vp-doc-aside-width` is 352px on a layout that holds one), and the intro's reading measure (`--fleet-measure`) and 18px size. Below carbon's 1280px aside breakpoint the card sits in flow ABOVE the article at the column's full width, the way a repository's About card leads its README on a phone.

- **The token is set on the layout,** not the doc, because the nav's search field spans the reading column by it too.
- **The card's top** reads `--fleet-content-top-height` to sit level with the h1.
- **The measure:** the landing's prose keeps it while its wide blocks (tables, code) use the full column.

### `facts.css`

The project facts card (`facts-panel.ts`): the panel material, the title rule, one grid with every section, row and nested item list a subgrid of it, chips for topics, path segments that wrap whole, and the compact layout below 1280px.

- **One markup, two layouts:** indented rows under the count in the aside (1280px and up). In flow above the article, a compact strip with left-aligned values, the items inline after their label, the count hidden, and the description clamped to two lines.
- **Compact rows** sit between 1.45 and 1.6 line-height.
- **Phones:** below 768px the card tightens further and drops to one level of divider.
- **The hue** appears only on the title rule and the repository link.

### `not-found.css`

Carbon's not-found page in the fleet's type: the number in the display face, the title (config.mts sets its text in sentence case) at the h2's weight, the link a button in the theme's radius and hover timing.

- **Text and metrics only:** the page keeps carbon's markup.

### `print.css`

The print sheet: the article alone on paper.

- **The chrome is gone:** nav, local nav, sidebar, aside, launcher, skip link, code controls, pager.
- **The page:** the column spans the page, external links print their address in their `::after`, and code blocks and tables never split across pages.
- **Nothing scrolls:** tables fit the page, code wraps, the line-number gutter goes.
- **Never printed:** a diagram's Zoom button, its open view, and an open image lightbox (the original image shows again in the lightbox's place).

To change it:

- **The palette on paper** is `tokens.ts`'s print values (the token layer writes them on `html:root`).
- **The address** replaces carbon's masked icon box in the same `::after`, so the box's mask and size go too.
- **Imported after every component file,** so its overrides win ties.

### `motion.css`

The reduced-motion stop: every transition and animation on the page stops, carbon's `!important` ones included, the pager arrow's slide with them. The scroll-cue shadows keep their attachment, and the image lightbox's transition shortens to 1ms instead of stopping.

- **The only `!important` rules in the theme:** carbon's reduced-motion rules are `!important` and scoped, so only `!important` under a deeper selector wins.
- **medium-zoom** finishes an open or close on `transitionend`, which a transition of `none` never fires, so its transition is shortened, not stopped. Its own `!important` rule lands in a runtime style tag after the bundle, so `img.medium-zoom-image` outranks it by the type selector.
- **Imported last.**

### `index.ts`

The theme entry: carbon as base, the font imports, which components mount where, the global `FleetLauncher` registration.

- **A VitePress `Theme`:** keep exporting one.
- **The slot mounts:** if you change the `Layout`, keep the three: `NavLauncher` in `nav-bar-content-before`, `FactsPanel` in `aside-top`, `Provenance` in `doc-after` (carbon forwards all default-theme slots).
- **Beside the layout:** keep `MermaidDiagrams` and `ImageZoom` BESIDE carbon's `Layout` (the theme's `Layout` renders them as one fragment). The doc slots skip a `layout: page` or `home` page and `layout: false` skips every slot, while a sibling of the layout runs on every page.
- **The `FleetLauncher` registration:** `enhanceApp` must keep `ctx.app.component("FleetLauncher", ...)`. The landing-table rule emits that tag, and an unregistered tag renders empty.
- **The fonts** are `@fontsource-variable` packages imported before the CSS (self-hosted). Remote font links are banned, and `../config.mts`'s PostCSS filter drops carbon's own remote `@import` rules.
- **The hue stamp:** in the browser `enhanceApp` also stamps `data-fleet-hue` on `<html>` from `themeConfig.docsSiteFacts` when the attribute is missing. Built pages carry it from `../config.mts`'s `transformHtml` (so there is no flash), and `vitepress dev`, which never runs that hook, gets it here.
- **The tier guard:** in the browser it must also keep installing `tier-routes.ts`'s guard as `ctx.router.onBeforeRouteChange`. Without it a link into another version (the facts card's versions, a same-origin homepage, a markdown link) is served from this build's page map and renders the SPA's 404.

### `tier-routes.ts`

The router guard (`tierRouteGuard`): a route outside this tier's build (the site root from a version, another version's directory, anything else on the origin) becomes a full page load instead of a client-side route.

- **Why it exists:** every tier is its own VitePress build under its own base, and the client router intercepts every same-origin html link (it skips only `target`, `download`, `.vp-raw`). The guard is what keeps cross-tier links working.
- **The version roots** come from `themeConfig.docsSiteVersions`, because the root tier's base prefixes theirs.
- **The document's own path:** a route to it never leaves. The router resolves it on boot, and the document may be the root tier's `404.html`, which Pages serves for a missing path in any tier (leaving there would reload forever).
- **Pure and browser-free** (`tests/actions/pages-site/tier_routes.test.ts`); `index.ts` wires it.

### `facts-panel.ts`

The project facts card (class `fleet-facts`) on landing pages: description, repository, homepage, topics, toolchain versions, served versions, license.

- **When it renders:** only when `frontmatter.fleetLanding` and `themeConfig.docsSiteFacts` both exist.
- **One grid:** every section (a `dl`), row, and nested item list is a subgrid of it, so the label column is shared and values start on one line.
- **Counted groups** (toolchains, versions) keep their items INSIDE their value cell (`fleet-facts-items`). That is what lets `facts.css` lay the same markup out two ways: indented rows under the count in the aside (1280px and up), and, in flow above the article, a compact strip with left-aligned values, the items inline after their label, the count hidden, and the description clamped to two lines.
- **The look:** section heads by weight, the hue only on the title rule and the repository link. Topics are chips (`fleet-facts-topic`) under their label at the card's full width, each wrapping whole.
- **No heading of its own:** the card is an `aside` labelled About (`aria-label`) with no title. The landing h1 beside it already names the project, and the aside-top slot renders before that h1, where a heading would break the heading order.
- **Path-like values** (repository, homepage) render one inline-block segment per slash (class `fleet-facts-segment`, a `<wbr>` between), so a wide value splits at a slash first. A segment wider than the column alone falls back to `overflow-wrap: anywhere`.

### `provenance.ts`

The provenance line (class `fleet-provenance`) under every page: the ref and commit the tier was built from, and the page's source file.

- **Its inputs:** `themeConfig.docsSiteFacts` (its `provenance`) and `page.filePath`, which `../config.mts`'s `transformPageData` has already turned into the repository path (`docs/<dir>/README.md`, or `skills/<name>/SKILL.md` for an include root's page). So the line and the edit link name the same file.
- **No facts, no line:** it renders nothing without facts.
- **Its landmark:** a `section` with `aria-label="Page provenance"`, a region landmark of its own, so the line never falls outside every landmark. Never a `footer`, since carbon's doc footer, when present, already supplies the page's contentinfo landmark.

### `mermaid.ts`

The diagram component (`MermaidDiagrams`). It runs the render pass in `mermaid-render.ts` after every content update and again when `isDark` flips, since the colors are baked into the SVG, and it renders `mermaid-zoom-view.ts`'s view.

- **Beside the layout:** rendered beside carbon's `Layout` in `index.ts`, never in one of its slots. The doc slots skip a `layout: page` or `home` page and `layout: false` skips every slot, and the fences on such a page would stay source forever.
- **Server-safe:** browser APIs stay inside the callbacks; on the server the view renders closed.

### `mermaid-render.ts`

The render pass:

1. finds the page's `fleet-mermaid` mounts
2. loads the `mermaid` package on the first one it ever sees
3. waits for the theme's mono face over every mount's text (`document.fonts.load`)
4. renders each mount's source (the `pre`'s text) into a `fleet-mermaid-diagram` child
5. attaches `mermaid-zoom.ts`'s button

A failed render leaves the source, drops the button, and puts the error's first line in a `fleet-mermaid-error` line. `data-state` on the mount (`rendered`, `error`) tells `mermaid.css` which to show.

- **A lazy package:** the package is a dynamic import inside the pass, so a page without a mount downloads none of it. `tests/actions/pages-site/mermaid_render.test.ts` pins that against a stub, and `tests/ci/pages_site_build` pins that no page references the mermaid chunk.
- **The face wait comes before `initialize`:** mermaid measures labels in whatever face is usable at that moment, and the browser fetches a face only once laid-out text uses it. Without the wait a first render measures in the fallback face. A face that fails to load renders in the fallback rather than failing the mount.
- **Strict:** mermaid runs with `securityLevel: "strict"` (labels cannot carry HTML) and `suppressErrorRendering`, so a failed parse is the theme's to show.
- **Overtaken passes:** a pass overtaken by a later one (a toggle mid-render, a navigation) stops at its next await, so the newest theme lands last. A failed load is not cached, so the next pass retries.
- **Kept apart from the component** so the pass runs under bun against a stub document.

### `mermaid-theme.ts`

Mermaid's `themeVariables` from the fleet's tokens, per screen mode and hue: the code ground under the diagram, the panel ground for nodes and actors with the hue as their border, the raised ground for notes and labels, lines in the secondary ink, text in the primary ink, the mono stack and the code size as the type.

- **Literal colors:** mermaid needs them (it derives its palette from them), so the values are `tokens.ts`'s hex per mode, never a var(). A token change reaches diagrams through here for free; a new variable must be a token's value.
- **Contrast:** every text variable is held to 4.5:1 on the surface it is drawn over in `tests/actions/pages-site/theme_contrast.test.ts`. A variable that puts text on a new surface adds its pair there.
- **Browser-safe by construction** (imports `tokens.ts` alone).

### `mermaid-zoom.ts`

The Zoom button (`fleet-mermaid-zoom`, `aria-label="Zoom the diagram"`) that `mermaid-render.ts` attaches to each rendered mount, and the `shown` ref (the mount and its diagram element) that the view in `mermaid-zoom-view.ts` follows. The ref moves four ways:

- a Zoom button sets it
- reka's close clears it
- a render pass that redraws a mount on show (an appearance flip bakes new colors) sets a fresh object for the same mount
- a pass that fails the mount, or one that runs on a page without it (the browser's Back and Forward reach a page under a modal), clears it

To change it:

- **It imports `vue` alone:** the render pass imports this file, and `tests/actions/pages-site/mermaid_render.test.ts` runs it under a fake document with no `window`. Reka-ui reads `window` as it loads and keeps the answer for the whole bun process; that test walks the pass's static import graph and pins that no reka-ui or vueuse specifier is in it.
- **A same-mount redraw is a fresh object on purpose:** the render pass keeps the diagram element and swaps the SVG inside it, so only the object's identity can carry the news to a watcher.

### `mermaid-zoom-view.ts`

The full-size view (`MermaidZoomView`, rendered by `mermaid.ts`): reka-ui's modal `Dialog`, portaled to `body`. Its `DialogContent` (`fleet-mermaid-view`) holds a visually hidden `DialogTitle`, a control bar, and a copy of the mount's SVG at its viewBox size on a focusable stage (`role="group"`, its label naming the keys). Close is a `DialogClose`.

The stage is driven by [@panzoom/panzoom](https://github.com/timmywil/panzoom) 4.6.2 (pinned exact in `../../package.json`):

- its wheel, pinch and drag
- its `zoomIn` / `zoomOut` / `reset` behind the Zoom in / Zoom out / Reset buttons and the plus, minus and 0 keys
- its relative `pan` behind the arrow keys

To change it:

- **reka-ui owns the modal layer:** the focus trap, Escape, the body scroll lock, `aria-hidden` on the rest of the page, and focus back on close to the element that had it as the view opened (the Zoom button, for a reader who pressed it). The scroll lock rides on the `DialogOverlay`, which is why the unstyled overlay stays.
- **Panzoom drives the canvas** around the copy, not the copy, so a redraw swaps the copy under an untouched transform. `animate` stays off, so the view has no motion of its own.
- **The copy keeps the SVG's id:** mermaid scopes the styles inside the SVG to it, so a renamed copy loses them.
- **Its lifetime:** the bar and the stage are a child component mounted while the view is open, so Panzoom lives exactly as long as its canvas, and the redraw reaches it as a watch on its `shown` prop.

`tests/actions/pages-site/theme_layout.test.ts` opens the view in headless Chrome and holds:

- the copy at its viewBox width
- the pixel wheel, the drag and the arrow keys (a chord left alone) through the browser's input path
- a page-unit wheel as a dispatched event
- the redraw under a system appearance flip
- the dialog's accessible name
- the body scroll lock and focus back on Escape
- the close when history leaves the page

### `image-zoom.ts`

The image lightbox (`ImageZoom`, no markup of its own): [medium-zoom](https://github.com/francoischalifour/medium-zoom) 1.1.0 (pinned exact in `../../package.json`).

- **What it attaches to:** after each content update, every `.vp-doc img` outside a link or a native button (which own their image) whose alt has a word in it. An image with no alt, or a blank one, has no name to be a button under; CSS cannot trim, so the filter is in code.
- **Detached first,** so the new page's images are the ones it holds.
- **The page is `inert`:** the page (`.Layout`) is `inert` while the lightbox is up, since medium-zoom's overlay is not modal and Tab would reach the nav behind it.
- **A stuck open:** the page comes back on a content update only when the open never finished, since a srcset image whose candidate never loads leaves medium-zoom mid-open for good and it never closes.
- **A finished open** is closing, its fade over the page, and `medium-zoom:closed` frees it. One still in its transition takes the page back at `medium-zoom:opened`. medium-zoom's detach leaves its listeners on the image.
- **Keyboard:** each attached image is a focusable `role="button"` (its alt the name) that Enter and Space open, since medium-zoom binds a click alone.
- **Focus back on close:** to the image that had it as the lightbox opened, by key or by a click on the focusable image. It returns after the page leaves `inert` (an inert element takes no focus; the hidden original had dropped it) and without scrolling (a scroll past medium-zoom's offset is one way to close).
- **The attributes** leave the original at `medium-zoom:open`, before the library clones it (a srcset image gets a second copy later), and return at `medium-zoom:closed`.
- **The overlay's ground** is `--vp-c-bg`; a click or Escape closes.

To change it:

- **Beside the layout:** rendered beside carbon's `Layout` in `index.ts` like `mermaid.ts`, so the hook runs on every page. The selector is the article's (`.vp-doc`), so a `layout: page` article's images stay plain.
- **Made in the browser on first use:** `mediumZoom()` binds document listeners as it is created.
- **A linked image** stays its link's.

`tests/actions/pages-site/theme_layout.test.ts` opens the lightbox in headless Chrome and holds:

- the zoomed copy wider than the inline image
- the linked, the in-button, the empty-alt, the no-alt and the blank-alt image unattached
- focus back on the image after a click open and after a key open
- the page inert with focus refused everywhere behind the overlay (and taken somewhere with no lightbox up, the probe's control)
- inert again when a healthy open finishes over the page a route change swapped in
- the page inert under the fade when a finished lightbox is left through history, and free once it closes
- (in its own tab) the page back from inert on the next content update after a stuck open, Escape closing it, under reduced motion too, and Enter on the focused image opening it

### `image-zoom.css`

The lightbox's stacking: the overlay and the zoomed copy above carbon's highest layer, the sidebar on a phone and the nav from 960px up.

- **Beating medium-zoom's rules:** medium-zoom injects its own rules (overlay, hidden original, zoomed copy) in a runtime style tag AFTER the bundle. A theme rule that must beat one of them (`motion.css`, `print.css`) needs the higher specificity of a type selector, never a tie.

### `pages.data.ts`

The launcher's page-and-heading index, built once per site build from the docs tree (URL, title, directory, locale, h2/h3 anchors per page), in sidebar order (`../sidebar.ts`).

- **Keep exporting `data: PageIndexEntry[]`:** the launcher component reads it. The order of its page and directory groups is the index's, so the launcher and the sidebar agree.
- **The shared renderer:** it renders every page through it, so it needs `headersRule` and `inlineTextRule` installed by `../config.mts`.
- **Include directives:** a page with a VitePress `@include` directive that VitePress would expand lists no heading rows. The directive expands only in the page transform, so the unexpanded source would shift or collide its anchors. Full-text search still reaches those headings.
- **Which directives count:** the test mirrors VitePress's own resolution (relative to the page, `@/` against srcDir, region and range suffixes stripped) and asks whether that path is a regular file. A directive VitePress cannot read (a missing file, a directory, a path through a file), the usual case for one quoted in prose or a code span, changes nothing.

### `page-index.ts`

The page index's builder: `headersRule` stamps each page's top-level h2 and h3 headings on the render env, and `buildPageIndex` turns the pages into the entries `pages.data.ts` serves.

- **URL rules** come from `../derive.ts`, never restated here.
- **The headings come out of a full render,** so VitePress's own pipeline, frontmatter stripping included, decides which headings exist. A renderer without `headersRule` throws: the stamp is the contract.

### `launcher.ts`

The search launcher component, registered globally as `FleetLauncher` (class `fleet-launcher`). It is reka-ui's Listbox: `ListboxRoot` as the section, `ListboxFilter` as the field, `ListboxContent` as the grouped list, `ListboxGroup` and `ListboxGroupLabel` per group, `ListboxItem` per row or fold row.

Escape clears the field. The full-text fallback is a "Text matches" group from VitePress's local search index when no page or heading matches.

- **Its mounts:** the `<FleetLauncher rows="...">` tag the landing-table rule emits (mode `panel`), and `nav-launcher.ts` (mode `dialog`).
- **Server-rendered:** the list renders server-side, so browser APIs stay inside `onMounted` and handlers.
- **Listbox, not Combobox:** reka-ui's Combobox content aria-hides the rest of the page while mounted, and the panel is always mounted.
- **reka-ui owns the highlight:** arrows, Home/End, hover, `aria-activedescendant`, `data-highlighted`, Enter clicking the highlighted row.
- **This file owns the field's combobox attributes,** and the rule that a highlight naming no connected row moves to the first row (or to nothing over an empty list; reka does not watch the theme's row membership).
- **The options are the interactive elements themselves** (`tabindex=-1`, mousedown stopped), so nothing in the list is in the Tab order and a press never moves focus off the field.
- **The keyboard flag:** this file owns the `data-keyboard` flag `launcher.css` shows the field's focus ring on (the exported `keyboardInput` ref, written by `nav-launcher.ts`). Never `:focus-visible`, which Chromium matches for programmatic focus too.
- **Where the rest lives:** pure helpers live in `launcher-view.ts`; grouping and matching rules stay in `launcher-model.ts`.

### `nav-launcher.ts`

The nav's launcher entry and the shortcut owner. The entry (class `fleet-launcher-button`, reka-ui's `DialogTrigger`) opens the launcher in reka-ui's `Dialog`, portaled to `body`:

- `DialogOverlay` (class `fleet-launcher-backdrop`)
- `DialogContent` (class `fleet-launcher-dialog`) with a visually hidden `DialogTitle`, the launcher, and a `DialogClose` button (class `fleet-launcher-close`, `aria-label="Close search"`, after the launcher so Tab from the field reaches it)

The shortcut: Cmd K, Ctrl K, and `/` outside a field focus the landing panel when the page has one, else open the dialog.

To change it:

- **Mounted in `nav-bar-content-before`** on every page. `launcher.css` hides the button while a landing panel is on the page, so a landing page without a curated table still has search.
- **reka-ui owns the modal layer:** focus trap, focus to the field on open, focus back to the opener on every close, the body scroll lock, `aria-hidden` on the rest of the page.
- **A capturing listener:** the shortcut is a capturing window listener (`@vueuse/core`'s `useEventListener`) that stops carbon's own search hotkeys. Keep it capturing, or carbon's hidden search box opens instead.
- **Keyboard input:** the same listener and its pointerdown twin write `launcher.ts`'s `keyboardInput` ref. So the key that opens the dialog counts as keyboard input for the field's focus ring even though the launcher mounts after it.

### `launcher.css`

The launcher's rules: panel material, the 64px field, group heads and rows, the fold row, the empty state, the nav button, the dialog, the mobile collapse, and `.VPNavBar .VPNavBarSearch { display: none }`. That last rule retires carbon's search button; `search: local` stays in `../config.mts` so the index the fallback loads still ships.

The nav button by viewport width:

| Width | The nav button |
| --- | --- |
| below 768px | a 48px icon docked beside the hamburger; its hover border is behind `(hover: hover)` so a tap does not leave it lit |
| 768px to 959px | in the nav's flex row, centered |
| 960px to 1279px | positioned against the full-width nav bar and centered on the viewport, its width backing off from the title column |
| 1280px and up, on pages with a sidebar | back in the nav's flex row with its left edge on the article's left edge and its width the article's, by carbon's own arithmetic restated; it shrinks when the nav's controls need the room rather than overlapping them |
| 1280px and up, a page without a sidebar (the 404) | stays centered |
| 1280px and up, a page without an aside | follows the article's centered column |

To change it:

- **The hue** appears on the highlighted row (the tint plus a 2px inset ring), the focused field (the icon on focus, plus a 2px inset ring on the field wrapper while the launcher carries `data-keyboard`), and focus rings only.
- **Non-color cues:** each state has one at 3:1 or better against the panel, and matches are bold, never colored.
- **Line-heights:** rows that can wrap (labels, notes, group heads, the fold row, the empty state) sit at 1.6; the single-line controls (the input, the keycaps, the nav button) sit at 1.5.
- **Hover-only rules** stay under `@media (hover: hover)` so a tap never leaves one stuck on.
- **The dialog** is a fixed flex column sized in `dvh` units (the list takes what the field and the status line leave) above the nav and the sidebar with its backdrop.
- **While the dialog is open:** the nav button hides (`[data-state="open"]`, reka-ui's), and reka-ui locks the page's scroll.
- **One entrance:** the panel and the dialog rise on `--fleet-transition` alone, no second duration.
- **The highlighted row** is `[data-highlighted]`, reka-ui's attribute.
- **Keep `prefers-reduced-motion` honored.**

### `local-search.d.ts`

The ambient type for VitePress's `@localSearchIndex` virtual module: one lazy loader per locale key, resolving to the serialized MiniSearch index.

- **Hand-written:** type-only and written to the shape VitePress's local-search plugin emits today. tsc trusts it, so a VitePress bump must be checked against the plugin's `load()` output by hand.

### `css.d.ts`

The tsc-side stand-in for Vite's CSS handling (`declare module "*.css"`): the theme's side-effect CSS import is real at build time, where Vite bundles it, and typeless to tsc.

### `launcher-model.ts`

The launcher's pure model: curated rows plus the page index become filterable groups (`buildGroups`, `filterGroups`, `matchRanges`). A page row's note is its site path (`guide/setup`), a heading row's the page title.

- **Browser-safe by construction:** no node imports, because the client bundle imports it.
- **The rules live here:** change the grouping, folding, or matching rules here, never in the component. A page group folds its headings when it has two or more, keeping its curated and page rows in view; a directory group folds past 8 items; `splitRows` says which rows a fold hides.

### `launcher-view.ts`

The launcher's pure view helpers, among them which groups show open, the rows a group shows with its fold row, the fold label, the hotkey intent, the "Text matches" group, and the Cmd or Ctrl label.

- **No vue or vitepress import,** so the test suite loads it without a VitePress process, and `launcher.ts` and `nav-launcher.ts` stay renderers.

### `../landing-table.ts`, `../inline-text.ts`

The landing-page markdown rule: the first table with a column of bare links on a locale root's index.md becomes `<FleetLauncher rows="...">`. `inline-text.ts` stamps plain text on every inline token for it and for the page index. A table without a link column, or on any other page, renders as a table.

`../config.mts`'s `markdown.config` installs SEVEN rules, in this order; keep all seven there:

| Rule | From | Note |
| --- | --- | --- |
| `inlineTextRule` | `../inline-text.ts` | |
| `rewriteLinksRule` | `../rewrite-links.ts` | before the landing rule |
| `landingTableRule` | `../landing-table.ts` | the landing rule |
| `tableWrapRule` | `../table-wrap.ts` | after the landing rule |
| `headersRule` | `page-index.ts` | |
| `alertTitlesRule` | `../custom-blocks.ts` | GitHub-style alert titles |
| `mermaidRule` | `../mermaid.ts` | |

The page index's header reader throws without `headersRule`, and without the others source-file links, tables, alerts, labels and diagram fences render unprocessed.

### `../mermaid.ts`

The mermaid fence rule: a fence whose info string starts with `mermaid` renders as `<div class="fleet-mermaid" v-pre><pre class="fleet-mermaid-source">` holding the HTML-escaped source, the mount `mermaid-render.ts` renders and `mermaid.css` styles. Every other fence goes to the renderer VitePress installed (shiki, copy button, line numbers).

- **Inside a `::: code-group`** the mount is also a `vp-block` (VitePress's class for a group's non-code block, which carbon's tabs show and hide), and `active` when the group's first fence.
- **Outside the fence chain:** registered from `../config.mts` in `markdown.config`, so it wraps VitePress's fence chain from the outside and a mermaid fence never reaches shiki.
- **`v-pre` is load-bearing:** `{{ }}` is mermaid's hexagon node and Vue would compile it.
- **The source is carried once,** as the `pre`'s text (the client reads `textContent`), so no attribute duplicates it.
- **The active marker:** the code-group container marks its first fence ` active` in the info string, the same marker VitePress's own wrapper reads. A mount without the `vp-block` class inside a group would show beside the active fence, or be the missing active block the tabs cannot switch from.

### `../custom-blocks.ts`

The custom-block titles in sentence case (`CUSTOM_BLOCK_LABELS`), in one place for the two VitePress plugins that render them. The `:::` container plugin takes the labels as options; VitePress 1.6 installs its GitHub-alert plugin (`> [!NOTE]`) with no options, so `alertTitlesRule` retitles those tokens from the same table.

### `../config.mts`

Site structure:

- carbon's `baseConfig`, and the title/base/srcDir wiring (env-driven, leave intact)
- the sidebar (from `sidebar.ts`) and rewrites (from `derive.ts`, the include roots' page files among them)
- locales, the version menu (`../version-nav.ts`, below), and search
- editLink: `DOCS_SITE_EDIT_BASE` plus the page's repository path
- the translations menu pointed at each locale's landing page (`i18nRouting: false`, since a translation tree lags the root and the corresponding page is a 404 wherever it does)
- the pager labels (Previous, Next)
- carbon's Markdown menu switched off (`llms.pageActions: false`: its fetch path carries the site base twice on a based site; the per-tier `llms.txt` files still ship)
- the PostCSS filter that drops remote `@import` rules (carbon's Google Fonts and cdnfonts links)

And the facts contract:

- `DOCS_SITE_FACTS` (JSON `ProjectFacts` from `../../facts.ts`) into `themeConfig.docsSiteFacts`
- `frontmatter.fleetLanding` (with `outline: false`) on landing pages: a README.md or index.md source, never an include root's page
- every page's `filePath` rewritten to its repository path (`../source-path.ts`)
- a `name` frontmatter key as the title of a page with neither a `title` key nor an h1
- `data-fleet-hue` on `<html>`
- the meta description: the repository's description, else the site title
- a `<link rel="icon">` only when the docs tree ships `public/favicon.svg` or `public/favicon.ico`; never an invented one, and without it the browser falls back to the site's own favicon.ico

To change it: adjust `themeConfig` freely; the `DOCS_SITE_*` env contract at the top of the file belongs to the action and must keep working.

### `../version-nav.ts`

The version menu as a `themeConfig.nav` dropdown: one flyout named after the tier being read, one item per served tier (`latest`, `stable`, the tags), the current one marked in the flyout (carbon's narrow-screen list carries no marking).

- **Absolute URLs:** items are absolute URLs with `target: "_self"`. VitePress's `VPLink` prefixes this build's base onto a root-relative href, and the router hands any targeted link to the browser (every tier is its own build).
- **The env contract:** keep reading `DOCS_SITE_VERSIONS`, `DOCS_SITE_CURRENT`, and `DOCS_SITE_ORIGIN` - the build-time contract with the pages-site action. Versioned sites lose version navigation without it.

### `../source-path.ts`

A staged page's repository path (`docs/<dir>/README.md`, `skills/<name>/SKILL.md` under an include root's mount) and the landing-file test (README.md or index.md sources).

- **One answer per page:** `../config.mts` runs every page through it in `transformPageData`, so the edit link, the provenance line, and the landing flag agree on what a page is. Nothing on the node side reads `filePath` after that hook.

### `../anchors.ts`

Heading ids as GitHub assigns them: `githubSlug` over `headingText`. Text tokens have entities decoded, code spans stay literal, and the text is lowercased, punctuation dropped, spaces to hyphens, a leading digit kept.

- **Wired** as `markdown.anchor.slugify` and `getTokensText` in `../config.mts`. The headers plugin and the launcher's page index read the anchor's id, so the outline, the search rows, and a `#fragment` written for the README on GitHub all name the same element.
- **Changing the algorithm** changes every site's anchors at once.

### `../rewrite-links.ts`

The markdown-it rule that resolves every relative link in REPOSITORY space, as it reads on GitHub:

- **Inside the docs tree or an include root:** the target becomes its on-site route, a source file name such as `guide/README.md` or `../<skill>/SKILL.md` through the rewrite map.
- **Elsewhere in the repository** (`../.github/workflows/ci.yml`, `../README.md`): the target becomes that file's GitHub URL at the tier's ref.

To change it:

- **Registered before the landing rule** in `../config.mts`'s `markdown.config`, so the curated table's hrefs are the routes its rows attach to.
- **`index.md` targets:** VitePress's own link rule then turns an `index.md` target into the directory URL, as it always did for `index.md` links.
- **Without this rule** such links render as `README.html` or `../.github/...` and 404 on the site while passing VitePress's dead-link check (which consults the map and skips non-page files).

### `../derive.ts`

Route and locale derivation from the docs tree, and the per-page read:

- **The rewrite map:** each README.md and each include root's page file to its directory's index.md.
- **`readPage`:** the title from the `title` frontmatter, else the h1, else the `name` frontmatter, and the sidebar's `order` and `group` keys; malformed ones fail the build by name.
- **Change the derivation rules here** to change every site's routes and page identities.

### `../conventions.ts`

The docs conventions the site build and the plan action share (`../derive.ts`, `../../lib.ts`, `actions/plan/registration.ts`), so an include root the plan accepts is one the site builds: the locale-directory test, the landing file names, and the include-root shapes with their problems.

- **It imports nothing:** `build.ts` copies `.vitepress/` into every build root, where an import reaching outside resolves to nothing, and the plan action imports it with none of pages-site's dependencies installed.

### `../url-path.ts`

A URL path and the file path it names, converted segment by segment (`decodePathSegments`, `encodePathSegments`). A `#` or `?` in a file name is that name's own character, so it travels percent-encoded as path data; `decodeURI` and `encodeURI` would keep or emit it as the URL's fragment or query delimiter instead.

### `../sidebar.ts`

The sidebar. Per level it lists:

1. the landing
2. pages by `order`
3. the pages the landing's first link-column table names, in its order
4. the rest in file order

Pages sharing a `group` sit under one plain (non-collapsible) heading where the first member falls, and each directory is one collapsible group. A landing row titled like the site reads Overview. `sidebarOrder` flattens the same walk for the page index.

- **Documented for fleet authors** in `docs/site.md` (Docs conventions): change the ordering rule here and there together.
- **The landing table** is the one the launcher rule in `../landing-table.ts` finds (it stamps the table's links on every page's render env, `CuratedEnv`).
- **Read through VitePress's own renderer,** so containers and links parse as they do on the page. A landing with an include directive VitePress would expand names no links, as the page index lists no headings for such a page.
- **Matched like the launcher:** each link is matched to its page the way the launcher attaches a curated row (`launcher-model.ts`'s `resolveHref` and `pageKey`), so the sidebar and the launcher never disagree on which table counts or which page a row names.
- **An async config:** `../config.mts` is therefore async; it creates the renderer first.

### `../table-wrap.ts`

The markdown-it rule that wraps every top-level table in `div.vp-table[tabindex=0]`. The wrapper is the horizontal scroller `tables.css` styles at every width (a table wider than the doc column scrolls inside it with an edge shadow toward the hidden side; narrow ones still span it), and the tab stop keyboard users scroll from.

- **After the landing rule:** registered from `../config.mts` in `markdown.config` after the landing rule, so the launcher panel gets no wrapper.
- **After VitePress's renderer:** it is also registered after VitePress installs its own `<table tabindex="0">` renderer, which the rule bypasses for wrapped tables: a wrapped table keeps no tab stop of its own.
- **Nested tables** (blockquotes, lists) stay bare and keep VitePress's tab stop, since carbon's block still scrolls them.

### `../dir-title.ts`

A directory's display title (`api-reference/` reads as Api Reference), shared by the sidebar groups and the launcher's directory groups.

- **Browser-safe:** the client bundle imports it through `launcher-model.ts`.
- **One function,** so the sidebar and the launcher never name a folder differently.

## The VitePress 2 path (deferred deliberately)

`vitepress` stays on the 1.6 line because carbon@1.6.0 declares no VitePress 2 compatibility. When VitePress 2 goes stable, there are two moves:

- **Carbon has ported:** bump both pins together.
- **A token port:** reimplement carbon's `vars.css` values over VitePress's default theme in this directory. The file layout and the contract above are built so that swap stays local to this directory plus `../config.mts`'s `extends`/theme imports.

## Content rules

- Fleet docs are plain `.md` only - no MDX and no per-repo Vue components. Rich widgets are added HERE, as theme-provided [markdown containers](https://vitepress.dev/guide/markdown#custom-containers) or globally registered components, so every repository gets them for free.
- Translations follow one convention: `docs/<lang>[-<region>]/` (a two-letter ISO 639-1 code, e.g. `zh-cn/`, `ja/`) mirroring the root structure. Detected directories become VitePress locales with the language switcher in the nav (carbon ships the translations menu); the root tree is the default (English) locale. The detection rule lives in `../derive.ts`.
- The dropdown navigates to a version's ROOT, not the same page in the other version - page sets differ across versions, so deep cross-version links are not guaranteed to exist. Every version is its own build: a link into another one is a full page load (`tier-routes.ts`), never a client-side route.
