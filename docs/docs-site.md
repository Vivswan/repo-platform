# The docs-site module

Selecting the `docs-site` module publishes a repository's `docs/` markdown as a versioned VitePress site. The repository carries ONLY markdown: the VitePress config, theme, sidebar/nav derivation, and build pipeline all live in repo-platform's [pages-site action](https://github.com/Vivswan/repo-platform/blob/main/actions/pages-site/action.yml), and every fleet site picks up theme changes on its next deploy - the nightly rebuild makes that automatic. repo-platform dogfoods the module itself: this guide and the rest of `docs/` are the site at <https://vivswan.github.io/repo-platform/> (no version tags, so the root is the default branch's docs, the same content as `latest/`).

| URL | Built from |
|---|---|
| `https://<owner>.github.io/<repo>/` | the newest served version tag's docs (none served - no tags yet, or every tag skipped: the default branch's docs, the same content as `latest/`) |
| `.../<repo>/latest/` | the default branch's docs |
| `.../<repo>/vX.Y.Z/` | that tag's docs, one directory per kept tag |
| `.../<repo>/versions.json` | the version index the theme's dropdown is fed from |

Standalone, deploys run on pushes touching `docs/**`, nightly (04:41 UTC), and on dispatch; composed with the pages module, the deploy rides `pages.yml` instead (downstream of the `all-green` gate on every push to the default branch, 04:23 UTC nightly). Both shapes share the tag rules, version cap (`PAGES_MAX_VERSIONS`, default 5), custom-domain contract, and one-time setup of the [pages module](pages.md), whose pipeline this module shares.

## Content conventions

- Plain `.md` only - no MDX, no per-repo Vue components, no repo-local `.vitepress/` (the build REFUSES one: it could never apply, since the theme is central). Rich widgets arrive as theme-provided markdown containers for every repo at once.
- Double curly braces are Vue interpolation syntax, compiled even inside an inline code span (fenced code blocks are exempt): the build fails on them instead of shipping a blank page, so wrap literal ones in `<span v-pre>` or a `::: v-pre` container.
- Tables need no width tricks: a top-level table wider than the doc column scrolls horizontally inside the column instead of clipping at the viewport (one nested in a quote, list, or container gets no scroll wrapper).
- `docs/README.md` is the site's landing page; each directory's `README.md` is its index. The sidebar and nav derive from the file tree and each page's own frontmatter - there is no config file. A page is titled by its `title` frontmatter, else its first heading; a directory group takes its folder name with each word capitalized (`api-reference/` reads as Api Reference).
- Sidebar order within a directory: the landing page, then pages with an `order` frontmatter key (a number, ascending, ties by title), then pages the landing's link table names in the order it first names them, then the rest in file order. Pages sharing a `group` frontmatter key (a string) sit under one heading placed where the group's first member falls, so `order: 20` and `group: Modules` on a page's frontmatter both place it and head it. A tree with neither frontmatter nor a landing table keeps its file order; the search launcher lists pages and directories in the sidebar's order too. A landing page titled exactly like the site (the repository name) reads Overview in the sidebar, since the nav bar right above already carries that name.
- A table in `docs/README.md` whose one column is bare links to pages becomes the search launcher's curated rows (label from the first other cell, note from the remaining cells); without one the launcher lists every page and heading.
- VitePress `<!-- @include: file.md -->` directives work, but a page that uses one lists no heading rows in the launcher's page index (full-text search still reaches those headings), and a landing page that uses one places no pages by its link table (they keep file order). Only a directive VitePress expands counts: one naming a missing file, which is what a mention in prose or a code span normally is, changes nothing.
- Links must resolve INSIDE `docs/` (or be absolute URLs). A link to `../README.md` works on GitHub but is dead on the site, and dead internal links fail the build - that failure is the point, see the PR check below.
- Translations: put them in `docs/<lang>/` (a two-letter ISO 639-1 code, optionally with a region: `zh-cn/`, `zh-tw/`, `ja/`) mirroring the root structure. Detected directories become locales with the language switcher in the nav; the root tree is the default (English) locale, and a tagged version serves its own translations.

## The docs PR check

`docs-site.yml`'s check job builds `docs/` strictly on every PR touching it, so a dead link fails the PR instead of the deploy. It is paths-filtered and therefore NEVER a required check and never in the all-green roster ([all-green.md](all-green.md)) - a PR that skips it merges normally; one that runs it red still merges, but the author was told exactly which link broke.

Historical version tags are gentler: a tag whose tree has no `docs/` (or carries a pre-adoption `docs/.vitepress/`) is skipped with a notice, and dead links inside old tags do not fail the deploy - history cannot be fixed.

## Link rot

Nightly deploys crawl the assembled site's EXTERNAL links after publishing (internal ones were already fatal at build time). Findings ride the fleet's [tracking-issue stream](tracking-issues.md): one open issue under the `docs_site_label` answer's label (default `docs-link-rot`) listing every broken URL with up to five of the pages linking it, closed automatically on the first clean night. Like every tracking stream, an open issue holds releases on repos with the release-please module - `release-override` is the documented escape hatch.

## Module parameters (copier questions)

| Question | Meaning | Default |
|---|---|---|
| `docs_site_path` | URL path the docs mount under when the pages module also renders a website | `docs` |
| `docs_site_label` | The link-rot tracking issue's label | `docs-link-rot` |

## With the pages module

Both modules selected render ONE Pages deployment (`pages.yml`): the repo's own site at `/` (unversioned, built from the default branch) and the docs at `/<docs_site_path>/` with the full version rules. `docs-site.yml` renders down to just its PR check job. [pages.md](pages.md#with-the-docs-site-module) has the composed layout.

## What each page gets for free

- Local full-text search and per-page "Edit this page" links (default-branch tiers only, where an edit can still change the content).
- `llms.txt` and `llms-full.txt` per tier (the [llms.txt](https://llmstxt.org) convention), covering every locale.
- The version dropdown in the nav, fed from the same tag set as `versions.json`.
- The project facts card on the landing page: name, description, repository link, homepage and topics when set, toolchain versions, the served docs versions, and the license, read from the repository itself at build time.
- A provenance line under every page naming the ref and commit the tier was built from (linking to that commit) and the markdown file the page rendered from.

## Caveats

- Serving Pages from a private repository requires a paid GitHub plan, and the served site is PUBLIC on non-Enterprise plans - selecting the module is the opt-in to that, per repo.
- The theme is one for the whole fleet (dark by default with a light variant, and one accent hue per repository derived from its name), owned by [actions/pages-site/.vitepress/theme/](https://github.com/Vivswan/repo-platform/blob/main/actions/pages-site/.vitepress/theme/README.md), which documents exactly which file controls what. Nothing is configured per repository: the build reads the facts card's content from the repository itself (passed to the theme as `DOCS_SITE_FACTS`, read as `themeConfig.docsSiteFacts`), marks the landing page with the `fleetLanding` frontmatter flag, writes the repository's hue as `data-fleet-hue` on the page's `<html>`, and strips the base theme's remote font imports at build time (a PostCSS filter), so a site never loads a font from a third party.
