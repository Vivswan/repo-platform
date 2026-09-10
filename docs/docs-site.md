---
order: 120
group: Modules
---

# Docs site

Selecting the `docs-site` module publishes a repository's `docs/` markdown as a versioned VitePress site. The repository carries ONLY markdown: the VitePress config, theme, sidebar/nav derivation, and build pipeline all live in repo-platform's [pages-site action](https://github.com/Vivswan/repo-platform/blob/main/actions/pages-site/action.yml), and every fleet site picks up theme changes on its next deploy - the nightly rebuild makes that automatic. repo-platform dogfoods the module itself: this guide and the rest of `docs/` are the site at <https://vivswan.github.io/repo-platform/> (no version tags, so the root is the default branch's docs, the same content as `latest/`).

| URL | Built from |
|---|---|
| `https://<owner>.github.io/<repo>/` | the newest served version tag's docs (none served - no tags yet, or every tag skipped: the default branch's docs, the same content as `latest/`) |
| `.../<repo>/latest/` | the default branch's docs |
| `.../<repo>/vX.Y.Z/` | that tag's docs, one directory per kept tag |
| `.../<repo>/versions.json` | the version index the theme's dropdown is fed from |

Standalone, the deploy runs three ways: on every green push to the default branch it rides the managed ci.yml's run as the `docs-site` leg, downstream of the `all-green` gate and ordered behind the repo-owned post-green hook and the release leg (a tag minted in that run lands on this deploy; a red hook or release never holds the site back), calling docs-site.yml with the judged commit ([all-green.md](all-green.md#after-the-gate)); the nightly rebuild (04:41 UTC) and a manual dispatch build the default branch head. There is no push trigger of its own: a deploy on push would race the gate. Composed with the pages module, the deploy rides `pages.yml` instead (the same leg shape, 04:23 UTC nightly) and no docs-site leg renders. repo-platform's own ci.yml is hand-written and carries the same leg, so its site rebuilds after every publish of the `build` branch made inside a green main-push CI run (a `workflow_dispatch` of post-green.yml publishes without it) and ships the theme that publish landed. Both shapes share the tag rules, version cap (`PAGES_MAX_VERSIONS`, default 5), custom-domain contract, and one-time setup of the [pages module](pages.md), whose pipeline this module shares.

## Content conventions

- Plain `.md` only - no MDX, no per-repo Vue components, no repo-local `.vitepress/` (the build REFUSES one: it could never apply, since the theme is central). Rich widgets arrive as theme-provided markdown containers for every repo at once.
- Double curly braces are Vue interpolation syntax, compiled even inside an inline code span (fenced code blocks are exempt): the build fails on them instead of shipping a blank page, so wrap literal ones in `<span v-pre>` or a `::: v-pre` container.
- Tables need no width tricks: a top-level table wider than the doc column scrolls horizontally inside the column instead of clipping at the viewport (one nested in a quote, list, or container gets no scroll wrapper).
- A ```` ```mermaid ```` fence renders as a diagram in the site's colors, in both appearance modes, on its own or as a tab of a `::: code-group`. The diagram library loads only on pages that carry one; the fence's source stays on the page as the fallback without JavaScript and beside the error when the diagram does not parse. On paper the diagram prints as drawn from the light appearance, and as its source from the dark one (the drawn colors are the screen's).
- `docs/README.md` is the site's landing page; each directory's `README.md` is its index. The sidebar and nav derive from the file tree and each page's own frontmatter - there is no config file. A page is titled by its `title` frontmatter, else its `# ` h1, else its filename; a directory group takes its folder name with each word capitalized (`api-reference/` reads as Api Reference).
- Sidebar order within a directory: the landing page, then pages with an `order` frontmatter key (a number, ascending, ties by title), then pages the landing's link table names in the order it first names them, then the rest in file order. Pages sharing a `group` frontmatter key (a string) sit under one heading placed where the group's first member falls, so `order: 20` and `group: Modules` on a page's frontmatter both place it and head it. A tree with neither frontmatter nor a landing table keeps its file order; the search launcher lists pages and directories in the sidebar's order too. A landing page titled exactly like the site (the `project_name` answer, which can differ from the repository name) reads Overview in the sidebar, since the nav bar right above already carries that name.
- A table in `docs/README.md` whose one column is bare links to pages becomes the search launcher's curated rows (label from the first other cell, note from the remaining cells); without one the launcher lists every page and heading.
- VitePress `<!-- @include: file.md -->` directives work, but a page that uses one lists no heading rows in the launcher's page index (full-text search still reaches those headings), and a landing page that uses one places no pages by its link table (they keep file order). Only a directive VitePress expands counts: one naming a missing file, which is what a mention in prose or a code span normally is, changes nothing.
- Links are written as they read on GitHub and resolve in repository space: a link inside `docs/` (or into another root the site renders, see below) becomes the page's route, a link to any other file in the repository (`../.github/workflows/ci.yml`, `../README.md`) becomes a link to that file on GitHub at the version being read, and absolute URLs pass through. A link to a page's source file name (`guide/README.md`) renders as the directory URL, and heading anchors are GitHub's (`#3-add-checks-to-checksyml` reaches `## 3. Add checks to checks.yml` on both). Dead internal links fail the build - that failure is the point, see the PR check below - and once the site is assembled every same-site link is checked again across the whole artifact ([pages.md](pages.md#internal-links-are-checked-across-mounts)).
- Translations: put them in `docs/<lang>/` (a two-letter ISO 639-1 code, optionally with a region: `zh-cn/`, `zh-tw/`, `ja/`) mirroring the root structure. Detected directories become locales with the language switcher in the nav; the root tree is the default (English) locale, and a tagged version serves its own translations.

## Other roots on the site

The docs mount can render other directories of the repository beside `docs/`, so one artifact carries them and one link check covers them. Each root is one entry of the vitepress mount's `include` list in the pages-site action's mounts input:

```json
{"path": "skills", "mount": "skills", "page": "SKILL.md"}
```

| Key | What it names | With the example |
|---|---|---|
| `path` | The repository directory to stage | `skills/` |
| `mount` | The URL directory under the docs mount | `.../<repo>/skills/`, or `.../<repo>/<docs_site_path>/skills/` beside the pages module |
| `page` | The file that serves as each child directory's page | `skills/repo-platform-sync-pr/SKILL.md` renders at `/skills/repo-platform-sync-pr/` |

How a staged root renders:

- The other markdown files in a child directory render too, at their own paths relative to it.
- A `README.md` at the root of the include becomes the section's landing page.
- Every version tier stages the root from its own ref, so an old tag renders the skills it carried. A tag without the directory skips it with a notice; the default branch must carry every configured root.
- A mount that would misplace the pages is refused: a locale-shaped name (`de`), a segment the site never walks (dot-prefixed, `node_modules`), or `public/` (copied to the site root, not rendered). A child directory carrying both the page and an `index.md` fails the build, since both would serve at one URL.

The SKILL.md convention:

- A page with neither a `title` frontmatter key nor an h1 is titled by its `name` frontmatter key (else by its file name, when the key is missing or blank), in the document title and the sidebar alike, and its `description` key is the page's meta description, so a skill's own frontmatter is enough.
- Such a page is an article with its outline, not a landing page.
- The sidebar groups the root under its mount name with each word capitalized (`skills/` reads as Skills), and the search launcher lists its pages.
- The page's "Edit this page" link and provenance line name the real source path (`skills/<name>/SKILL.md`, never a path under `docs/`).

Links resolve the way they read on GitHub, from the page's own repository path:

| Written | Renders as |
|---|---|
| `[the sync skill](../repo-platform-sync-pr/SKILL.md)` on a skill page | that skill's directory URL, the way an `index.md` link always did |
| `[the sync skill](../repo-platform-sync-pr)` | the same directory URL: a directory with an index page resolves to it |
| `[guide](guide/README.md)` on a docs page | the guide's directory URL |
| `[sync PRs](../skills/repo-platform-sync-pr/SKILL.md)` on a docs page | the skill's page, across the two roots |
| `[plugin metadata](.codex-plugin/plugin.json)` on a skill page | the file on GitHub at the tier's ref: the site never publishes it |
| `[the workflow](../.github/workflows/ci.yml)` on a docs page | the same, for anything outside the staged roots |
| `[the actions](../actions/)` or `[the repository](../)` on a docs page | that directory's tree on GitHub at the tier's ref: a directory is known by its trailing slash, or by being the repository root |
| `[logo](public/logo.svg)` on a docs page | the file at the site base, where VitePress copies `public/` |

A `.md`, extensionless, or directory link to nothing stays on the site, so the strict build's dead-link check reports it; only a target with another file extension is read on GitHub.

One shape of file name cannot be linked from markdown: a `%` followed by two hex digits (`100%23b.md`). VitePress decodes the rendered href once more and collapses the escape, so the link names another file. Rename the file.

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
- The version dropdown in the nav, fed from the same tag set as `versions.json`. Every version is its own build, so a link into another version (the dropdown, the facts card, a markdown link) is a full page load, never a client-side route.
- The project facts card on the landing page: description, repository link, homepage and topics when set, toolchain versions, the served docs versions, and the license, read from the repository itself at build time.
- A provenance line under every page naming the ref and commit the tier was built from (linking to that commit) and the markdown file the page rendered from.

## Caveats

- Serving Pages from a private repository requires a paid GitHub plan, and the served site is PUBLIC on non-Enterprise plans - selecting the module is the opt-in to that, per repo.
- The theme is one for the whole fleet (dark by default with a light variant, and one accent hue per repository derived from its name), owned by [actions/pages-site/.vitepress/theme/](https://github.com/Vivswan/repo-platform/blob/main/actions/pages-site/.vitepress/theme/README.md), which documents exactly which file controls what. Nothing is configured per repository: the build reads the facts card's content from the repository itself (passed to the theme as `DOCS_SITE_FACTS`, read as `themeConfig.docsSiteFacts`), marks the landing page with the `fleetLanding` frontmatter flag, writes the repository's hue as `data-fleet-hue` on the page's `<html>`, and strips the base theme's remote font imports at build time (a PostCSS filter), so a site never loads a font from a third party.
