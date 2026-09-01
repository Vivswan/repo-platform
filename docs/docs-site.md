# The docs-site module

Selecting the `docs-site` module publishes a repository's `docs/` markdown as a versioned VitePress site. The repository carries ONLY markdown: the VitePress config, theme, sidebar/nav derivation, and build pipeline all live in repo-platform's [pages-site action](https://github.com/Vivswan/repo-platform/blob/main/actions/pages-site/action.yml), and every fleet site picks up theme changes on its next deploy - the nightly rebuild makes that automatic.

| URL | Built from |
|---|---|
| `https://<owner>.github.io/<repo>/` | the newest version tag's docs (before the first tag: a redirect to `latest/`) |
| `.../<repo>/latest/` | the default branch's docs |
| `.../<repo>/vX.Y.Z/` | that tag's docs, one directory per kept tag |
| `.../<repo>/versions.json` | the version index the theme's dropdown is fed from |

Standalone, deploys run on pushes touching `docs/**`, nightly (04:41 UTC), and on dispatch; composed with the pages module, the deploy rides `pages.yml` instead (every push to the default branch, 04:23 UTC nightly). Both shapes share the tag rules, version cap (`PAGES_MAX_VERSIONS`, default 5), custom-domain contract, and one-time setup of the [pages module](pages.md), whose pipeline this module shares.

## Content conventions

- Plain `.md` only - no MDX, no per-repo Vue components, no repo-local `.vitepress/` (the build REFUSES one: it could never apply, since the theme is central). Rich widgets arrive as theme-provided markdown containers for every repo at once.
- `docs/README.md` is the site's landing page; each directory's `README.md` is its index. The sidebar and nav derive from the file tree - there is nothing to configure.
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

## Caveats

- Serving Pages from a private repository requires a paid GitHub plan, and the served site is PUBLIC on non-Enterprise plans - selecting the module is the opt-in to that, per repo.
- The theme is a deliberate placeholder today: the real design drops into [actions/pages-site/.vitepress/theme/](https://github.com/Vivswan/repo-platform/blob/main/actions/pages-site/.vitepress/theme/README.md), which documents exactly which file controls what.
