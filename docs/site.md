---
order: 110
group: Modules
---

# Site

Selecting the `site` module arms the managed ci.yml's `site` leg: ONE GitHub Pages site per repository, deployed by repo-platform's [reusable-site.yml](../.github/workflows/reusable-site.yml) and the shared [pages-site action](../actions/pages-site/action.yml). Two things can be on it, alone or together:

| Part | Built by | Served at |
|---|---|---|
| The repository's own website | the repo-owned hook `.github/actions/site-build/action.yml` | `/` (one unversioned build of the judged commit) |
| The docs: `docs/` markdown under the central fleet theme | the fleet (VitePress, config and theme live in repo-platform; the repository carries only markdown) | `/<site.path>/` beside a website, else `/` (versioned by tag) |

repo-platform dogfoods the docs half: this guide and the rest of `docs/` are the site at <https://vivswan.github.io/repo-platform/>.

## The leg and its triggers

The `site` job in the managed ci.yml needs `ci`, `all-green`, `post-green`, and `publish-release`, and runs on every run of ci.yml on main whose gate passed: a push, the nightly schedule (the rebuild), and a manual dispatch (the manual deploy). There is no workflow of its own and no tag trigger: a tag created without a push lands on the nightly rebuild, or right away via dispatch. The job calls reusable-site.yml`@build` with `github.sha` (the judged commit, so a red main never reaches the site) and `vars.CUSTOM_DOMAIN`, and holds the `pages` concurrency lane.

The release legs sit before it as an ORDER, not a gate: the condition leads with `!cancelled()`, so the deploy waits for the release chain and then runs whatever its result, and a release commit's own deploy serves its new tag. Without the release-please module the release legs skip and the deploy follows the repo-owned post-green hook directly ([all-green.md](all-green.md#after-the-gate)).

The called workflow is one job, in this order:

| Step | Runs when | What |
|---|---|---|
| checkout | always | the judged commit, full history (the tag list is the version set) |
| urls | always | computes the base path (`/<repo>/`, or `/` with a custom domain) and the origin |
| hook | `.github/actions/site-build/action.yml` exists in the checkout | the repository's own build, in the same job and workspace |
| pages-site | always | assembles the layout below from the hook's `dist` and `docs/`, checks every internal link, writes `versions.json` under the docs mount and `CNAME` with a custom domain |
| configure, upload, deploy | something was built | the one Pages artifact, deployed to the `github-pages` environment |
| link rot | the schedule alone, after a deploy | crawls the site's external links and files the tracking issue ([below](#link-rot)) |

A repository with neither a hook output nor a `docs/` directory ends green with a notice (`nothing to publish`) and no deploy.

## The hook: `.github/actions/site-build/action.yml`

The hook is a universal starter: the sync seeds it once in every repository, module or not, as a no-op, and never rewrites it. It is a composite action, so the fleet can run it from the caller's checkout inside the deploy job and hand its output directory to the same job with no artifact hop; a repository that has not filled it in publishes `docs/` alone.

| Contract | Value |
|---|---|
| input `base-path` | the URL path the site is served under: `/<repo>/`, or `/` with a custom domain |
| input `origin` | `https://<owner>.github.io`, or `https://<domain>` |
| output `dist` | the built site's directory, relative to the repository root, with an `index.html`; empty (the seeded default) means no repository website |
| runs as | a step of the deploy job, on the checked-out judged commit, under that job's token (contents read, pages and id-token write, issues write) |
| refused | an absolute `dist`, one that leaves the repository (`..`, or a symlink resolving outside it), a missing directory, or one without `index.html`: the leg goes red naming the path |
| declares no `dist` output | only the docs directory publishes, when there is one, with a notice that the hook named no directory |

A bun website:

```yaml
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
      with: {bun-version-file: .bun-version}
    - {run: bun install --frozen-lockfile, shell: bash}
    - id: build
      shell: bash
      env: {PAGES_BASE_PATH: "${{ inputs.base-path }}", PAGES_ORIGIN: "${{ inputs.origin }}"}
      run: |
        bun run build:web
        echo "dist=apps/web/dist" >> "$GITHUB_OUTPUT"
```

An MkDocs website (uv):

```yaml
runs:
  using: composite
  steps:
    - uses: astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d # v10.0.1
    - {run: uv sync --frozen, shell: bash}
    - id: build
      shell: bash
      env: {SITE_URL: "${{ inputs.origin }}${{ inputs.base-path }}"}
      run: |
        uv run mkdocs build --site-dir dist
        echo "dist=dist" >> "$GITHUB_OUTPUT"
```

Map the two inputs onto whatever the tool expects (`ASTRO_BASE`/`ASTRO_SITE`, `vite build --base`, MkDocs `site_url`, mdBook `MDBOOK_OUTPUT__HTML__SITE_URL`), or ignore them for a path-relative site. Anything the repository's CI can install runs here; the fleet sees only the directory.

## Layout

| hook `dist` | `docs/` exists | The site |
|---|---|---|
| set | yes | the website at `/`, the docs versioned at `/<site.path>/` (default `docs`), one link check over both |
| set | no | the website at `/` alone |
| empty | yes | the docs versioned at `/` |
| empty | no | nothing published; the leg is green with a notice |

The website is one build of the judged commit: version navigation belongs to the docs. The docs mount carries the tag rules:

| URL under the docs mount | Built from |
|---|---|
| `/` | the newest served version tag's docs (none served: the default branch's docs, the same content as `latest/`) |
| `latest/` | the default branch's docs |
| `vX.Y.Z/` | that tag's docs, one directory per served tag |
| `versions.json` | the version index the theme's dropdown reads |

Versions are the repository's plain `vX.Y.Z` git tags (what release-please mints), newest first, the newest `PAGES_MAX_VERSIONS` of them (a repository Actions variable; unset means 5). Every deploy rebuilds every tier, so a theme or pipeline change restyles the whole site on the next run. A tag whose tree has no `docs/` is skipped with a notice, and dead links inside old tags never fail the deploy: history cannot be fixed.

## Docs conventions

- Plain `.md` only: no MDX, no Vue components, no repo-local `.vitepress/` (the build REFUSES one; the theme is central). Rich widgets arrive as theme-provided markdown containers for every repository at once.
- Double curly braces are Vue interpolation, compiled even inside an inline code span (fenced blocks are exempt): the build fails on them instead of shipping a blank page, so wrap literal ones in `<span v-pre>` or a `::: v-pre` container.
- `docs/README.md` is the landing page and must exist; each directory's `README.md` is its index. The sidebar and nav derive from the file tree and each page's frontmatter: `title` (else the h1, else the file name), `order` (a number, ascending), `group` (a heading placed where the group's first member falls). A directory reads as its folder name with each word capitalized.
- A table in `docs/README.md` whose one column is bare links to pages becomes the search launcher's curated rows (label from the first other cell, note from the rest); without one the launcher lists every page and heading. A landing page titled exactly like the site reads Overview in the sidebar.
- Links are written as they read on GitHub: a link inside `docs/` (or into another staged root, below) becomes the page's route, a link to any other repository file becomes that file on GitHub at the version being read, and absolute URLs pass through. Heading anchors are GitHub's. Dead internal links fail the build; that failure is the point ([the PR check](#the-docs-pr-check)).
- A ```` ```mermaid ```` fence renders as a diagram in the site's colors in both appearance modes; the source stays as the fallback without JavaScript and beside a parse error.
- A top-level table wider than the doc column scrolls horizontally inside the column.
- Translations go in `docs/<lang>/` (`zh-cn/`, `ja/`) mirroring the root tree: detected directories become locales with the language switcher, the root tree is the default locale, and a tagged version serves its own translations.
- Every page gets local full-text search, an "Edit this page" link on default-branch tiers, `llms.txt` and `llms-full.txt` per tier, the version dropdown, the project facts card on the landing page (read from the repository at build time), and a provenance line naming the ref, commit, and source file.
- One file name cannot be linked from markdown: a `%` followed by two hex digits (`100%23b.md`); VitePress collapses the escape. Rename the file.

## Other roots on the site (`site.include`)

The docs mount can render other repository directories beside `docs/`, so one artifact carries them and one link check covers them. Each root is one entry of the registration's `site.include` list:

```yaml
site:
  include:
    - { path: skills, mount: skills, page: SKILL.md }
```

| Key | What it names | With the example |
|---|---|---|
| `path` | the repository directory to stage | `skills/` |
| `mount` | the URL directory under the docs mount | `.../skills/` (or `.../<site.path>/skills/` beside a website) |
| `page` | the file that serves as each child directory's page | `skills/repo-platform-sync-pr/SKILL.md` renders at `/skills/repo-platform-sync-pr/` |

- A `README.md` at the include's root is the section's landing page; the other markdown files in a child directory render at their own paths.
- Every version tier stages the root from its own ref; a tag without the directory skips it with a notice, and the default branch must carry every configured root.
- Refused mounts: a locale-shaped name (`de`), a segment the site never walks (dot-prefixed, `node_modules`), `public/`. A child directory carrying both the page and an `index.md` fails the build.
- A `SKILL.md`-style page with neither a `title` nor an h1 is titled by its `name` frontmatter key, its `description` becomes the meta description, and its "Edit this page" link names the real source path.
- Links resolve from the page's own repository path: `../repo-platform-sync-pr/SKILL.md` on a skill page is that skill's directory URL; `.codex-plugin/plugin.json` is the file on GitHub at the tier's ref.

## The docs PR check

fleet-ci.yml's `docs-check` job builds `docs/` strictly on every pull request of a repository selecting `site` that carries a `docs/` directory, with the same include roots the deploy reads from the registration, so a dead link fails the PR instead of the deploy. It is one of the gating jobs behind `all-green`: the deploy would go red on the same link after the merge, and a job inside the `ci` call can never hang as an expected check the way a paths-filtered workflow could. A PR that changes no docs still runs it, quickly, over the unchanged tree. A `docs/` without `docs/README.md` fails it, naming the missing landing page.

Internal links are checked across the whole assembled site, served the way GitHub Pages serves it: an extensionless path is its `.html`, a directory is its `index.html`. Every same-site link on a page built from the default branch must resolve, wherever the target lives (a website page into the docs, a docs page to a staged skill, a `#fragment` naming a heading, an emitted asset, a link spelled with the site's own URL). A broken one fails with a `page -> link (reason)` list:

```text
broken internal links (page -> link):
  /repo/docs/latest/index.html -> /repo/docs/latest/skills/alpha/#nope (no element with id 'nope' on that page)
  /repo/index.html -> /repo/docs/skills/missing/ (status 404)
```

## Link rot

The nightly run crawls the deployed site's EXTERNAL links after publishing (internal ones are fatal at build time). Findings ride the fleet's [tracking-issue stream](tracking-issues.md): one open issue under the label of the `labels.site` registration key (default `docs-link-rot`), listing every broken URL with up to five of the pages linking it (a list past GitHub's issue body limit is cut at whole lines, naming how many are missing), closed automatically on the first clean night. While it is open it holds releases on repositories with the release-please module; `release-override` is the escape hatch. The check runs on the schedule alone, so a fixed link closes the issue on the next clean night, never on a push.

## Module parameters (registration keys)

| Key in `.repo-platform.yml` | Meaning | Default |
|---|---|---|
| `site.path` | the URL segment the docs mount under when the hook also builds a website | `docs` (`modules.site.path` in `files.yml`) |
| `site.include` | extra source roots staged into the docs ([above](#other-roots-on-the-site-siteinclude)) | none |
| `labels.site` | the link-rot tracking issue's label | `docs-link-rot` |

The plan action ([actions/plan](../actions/plan/action.yml), mode `site`) resolves them on every run from the registration and the build branch's `files.yml`. A registration still carrying a `pages:` or `docs_site:` block fails the plan with a message naming this module and the hook.

## Pages enablement

Nothing to do: the module's settings layer enables Pages with Actions-workflow builds on the next fleet settings apply ([settings.md](settings.md)). Only a deploy that must run before that apply needs the manual toggle: Settings -> Pages -> Source: GitHub Actions. The `github-pages` environment needs no protection rule: deploys never run on tag refs, and a required-reviewers rule there parks every deploy "waiting for review" with the later runs queued behind it on the `pages` lane. The settings apply does not manage environments, so remove such a rule by hand (Settings -> Environments -> github-pages).

## Custom domain

Three pieces have to agree; the repository variable only flips the build side:

1. DNS: point the domain at [GitHub Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site) (a CNAME record to `<owner>.github.io` for a subdomain, the Pages A/AAAA records for an apex domain).
2. Pages settings: Settings -> Pages -> Custom domain -> enter the domain (GitHub verifies DNS and provisions TLS here; the `CNAME` file in the artifact alone does not configure this).
3. Repository variable: set `CUSTOM_DOMAIN` (Settings -> Secrets and variables -> Actions -> Variables), e.g. `example.com`. The next deploy builds with the matching URLs: the base path becomes `/`, the hook's `origin` becomes `https://example.com`, and the artifact carries `CNAME`.

To go back, undo all three together (in particular, remove the variable AND clear the custom domain in Pages settings, or URLs and routing will disagree).

## Caveats

- The repository's website is one unversioned build of the judged commit; the `vX.Y.Z/` tiers exist only under the docs mount. A repository that wants versioned website builds puts them in its own hook output.
- The hook runs under the deploy job's token (`pages: write`, `id-token: write`, `issues: write`, the same exposure the release hooks have), so it runs only code from the judged commit.
- A repository that already had its own `.github/actions/site-build/action.yml` keeps it (`unchanged` in the sync report); the fleet passes it `base-path` and `origin`, which an unrelated action may not declare. The sync-pr skill's triage row covers it.
- A repository with a `docs/` directory but no `docs/README.md` is red on every PR (`docs-check`) until the landing page exists.
- Serving Pages from a private repository requires a paid GitHub plan, and the served site is PUBLIC on non-Enterprise plans: selecting the module is the opt-in to that, per repository.
- Prerelease-shaped tags (`v1.0.0-rc.1`) are not versions; only plain `vX.Y.Z` tags enter the version set.
- The theme is one for the whole fleet (dark by default with a light variant, one accent hue per repository derived from its name), owned by [actions/pages-site/.vitepress/theme/](../actions/pages-site/.vitepress/theme/README.md), which says which file controls what. Nothing is configured per repository, and the docs build strips the theme's remote font imports, so the docs never load a font from a third party (the hook's website is copied as built).
