---
order: 110
group: Modules
---

# Site

Selecting the `site` module arms the managed ci.yml's `site` leg: ONE GitHub Pages site per repository, deployed by repo-platform's [reusable-site.yml](../.github/workflows/reusable-site.yml) and the shared [pages-site action](../actions/pages-site/action.yml). Two things can be on it, alone or together:

| Part | Built by | Served at |
|---|---|---|
| The repository's own website | the repo-owned hook `.github/actions/site-build/action.yml` | `/` (one unversioned build of the judged commit) |
| The docs: `docs/` markdown under the central fleet theme | the fleet (VitePress, config and theme live in repo-platform; the repository carries only markdown) | `/<site.path>/` beside a website, else `/` (versioned by tag); off with `site.path: null` ([below](#turning-the-docs-half-off-sitepath-null)) |

repo-platform dogfoods the docs half: this guide and the rest of `docs/` are the site at <https://vivswan.github.io/repo-platform/>.

## The leg and its triggers

The `site` job in the managed ci.yml needs `ci`, `all-green`, `post-green`, and `publish-release`, and runs on every run of ci.yml on main whose gate passed:

| Trigger | The deploy it is |
|---|---|
| a push | the ordinary deploy |
| the nightly schedule | the rebuild |
| a manual dispatch | the manual deploy |

- **No workflow of its own and no tag trigger:** a tag created without a push lands on the nightly rebuild, or right away via dispatch.
- **The judged commit:** the job calls reusable-site.yml`@stable` with `github.sha`, so a red main never reaches the site, and holds the `pages` concurrency lane.

**The release legs sit before it as an ORDER, not a gate:** the condition leads with `!cancelled()`, so the deploy waits for the release chain and then runs whatever its result, and a release commit's own deploy serves its new tag. Without the release-please module the release legs skip and the deploy follows the repo-owned post-green hook directly ([all-green.md](all-green.md#after-the-gate)).

The called workflow is one job, in this order:

| Step | Runs when | What |
|---|---|---|
| checkout | always | the judged commit, full history (the tag list is the version set) |
| urls | always | computes the base path `/<repo>/` and the origin `https://<owner>.github.io` |
| hook | `.github/actions/site-build/action.yml` exists in the checkout | the repository's own build, in the same job and workspace |
| pages-site | always | assembles the layout below from the hook's `dist` and `docs/`, checks every internal link, writes `versions.json` under the docs mount |
| pages | something was built | asks GitHub whether the Pages site exists; absent, the deploy skips with a warning ([below](#pages-enablement)) |
| configure, upload, deploy | the Pages site exists | the one Pages artifact, deployed to the `github-pages` environment |
| link rot | the schedule alone, after a deploy | checks the site's external links with lychee and files the tracking issue ([below](#link-rot)) |

A repository with neither a hook output nor a `docs/` directory ends green with a notice (`nothing to publish`) and no deploy.

## The hook: `.github/actions/site-build/action.yml`

The hook is a universal starter: the sync seeds it once in every repository, module or not, as a no-op, and never rewrites it.

It is a composite action, so the fleet can run it from the caller's checkout inside the deploy job and hand its output directory to the same job with no artifact hop. A repository that has not filled it in publishes `docs/` alone.

| Contract | Value |
|---|---|
| input `base-path` | the URL path the site is served under, `/<repo>/` |
| input `origin` | `https://<owner>.github.io` |
| output `dist` | the built site's directory, relative to the repository root, with an `index.html`; empty (the seeded default) means no repository website |
| runs as | a step of the deploy job, on the checked-out judged commit, under that job's token (contents read, pages and id-token write, issues write) |
| refused | an absolute `dist`, one that leaves the repository (`..`, or a symlink resolving outside it), a missing directory, or one without `index.html`: the leg goes red naming the path |
| declares no `dist` output | only the docs directory publishes, when there is one, with a notice that the hook named no directory |

A website built by the repository's own toolchain (its setup steps go before the build step):

```yaml
runs:
  using: composite
  steps:
    - id: build
      shell: bash
      env: {PAGES_BASE_PATH: "${{ inputs.base-path }}", PAGES_ORIGIN: "${{ inputs.origin }}"}
      run: |
        <your build command>
        echo "dist=<the built site directory>" >> "$GITHUB_OUTPUT"
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

| hook `dist` | `docs/` exists | `site.path` | The site |
|---|---|---|---|
| set | yes | a segment (default `docs`) | the website at `/`, the docs versioned at `/<site.path>/`, one link check over both |
| set | no | any | the website at `/` alone |
| empty | yes | a segment | the docs versioned at `/` |
| set | yes | `null` | the website at `/` alone; `docs/` is the website's own business |
| empty | any | `null` | nothing published; the leg is green with a notice |
| empty | no | any | nothing published; the leg is green with a notice |

The website is one build of the judged commit: version navigation belongs to the docs. The docs mount carries the tag rules:

| URL under the docs mount | Built from |
|---|---|
| `/` | the newest served version tag's docs (none served: the default branch's docs, the same content as `latest/`) |
| `latest/` | the default branch's docs |
| `stable/` | the newest served version tag's docs, under a name that survives releases; absent while no tag is served |
| `vX.Y.Z/` | that tag's docs, one directory per served tag |
| `versions.json` | the index of served tiers (label and path each), written by the build for anything outside the site that needs the list; the theme's menu is built from the same data at build time |

- **Versions** are the repository's plain `vX.Y.Z` git tags (what release-please mints), newest first, the newest five of them (`MAX_VERSIONS` in [build.ts](../actions/pages-site/build.ts)).

- **The version menu** (VitePress's nav dropdown) appears once a tag is served and lists `latest`, `stable`, then the tags newest first; the tier being read names the menu.

- **A link that survives releases:** `/<mount>/stable/setup/` keeps resolving as tags come and go, where `/<mount>/v1.2.0/setup/` falls out of the served set after five more releases.

- **`stable/` is its own build** of the newest tag. A copy of the root's build carries the root's base in its client bundle, so its router cannot serve the `stable/` URLs.

- **Every deploy rebuilds every tier,** so a theme or pipeline change restyles the whole site on the next run.

- **Skipped tags:** a tag whose tree has no `docs/`, or a `docs/` with no landing page (`README.md` or `index.md`), is skipped with a notice, and dead links inside old tags never fail the deploy: history cannot be fixed.

## Docs conventions

- **Plain `.md` only:** no MDX, no Vue components, no repo-local `.vitepress/` (the build REFUSES one; the theme is central). Rich widgets arrive as theme-provided markdown containers for every repository at once.

- **Double curly braces** are Vue interpolation, compiled even inside an inline code span (fenced blocks are exempt): the build fails on them instead of shipping a blank page, so wrap literal ones in `<span v-pre>` or a `::: v-pre` container.

- **The landing page:** `docs/README.md` is the landing page and must exist; each directory's `README.md` is its index.

- **Sidebar and nav** derive from the file tree and each page's frontmatter: `title` (else the h1, else the file name), `order` (a number, ascending), `group` (a heading placed where the group's first member falls). A directory reads as its folder name with each word capitalized.

- **The search launcher:** a table in `docs/README.md` whose one column is bare links to pages becomes the search launcher's curated rows (label from the first other cell, note from the rest); without one the launcher lists every page and heading. A landing page titled exactly like the site reads Overview in the sidebar.

- **Links** are written as they read on GitHub: a link inside `docs/` (or into another staged root, below) becomes the page's route, a link to any other repository file becomes that file on GitHub at the version being read, and absolute URLs pass through. Heading anchors are GitHub's. Dead internal links fail the build; that failure is the point ([the PR check](#the-docs-pr-check)).

- **Diagrams:** a ```` ```mermaid ```` fence renders as a diagram in the site's colors in both appearance modes; the source stays as the fallback without JavaScript and beside a parse error. Its Zoom button (on hover, focus, or touch) opens the diagram at full size in a view that zooms by wheel, pinch, or buttons, pans by drag, and closes on Escape.

- **Wide tables:** a top-level table wider than the doc column scrolls horizontally inside the column. An inline-code token in a cell stays whole up to half the column and wraps inside past that, so a long token never squeezes its neighbour to a column of single words.

- **Translations** go in `docs/<lang>/` (`zh-cn/`, `ja/`) mirroring the root tree: detected directories become locales with the language switcher, the root tree is the default locale, and a tagged version serves its own translations.

- **Every page gets** local full-text search, an "Edit this page" link on default-branch tiers, `llms.txt` and `llms-full.txt` per tier, the version dropdown, the project facts card on the landing page (read from the repository at build time: the identity keys of `.github/settings.yml`, the toolchain pins, `LICENSE.md`), and a provenance line naming the ref, commit, and source file.

- **One file name cannot be linked from markdown:** a `%` followed by two hex digits (`100%23b.md`); VitePress collapses the escape. Rename the file.

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

- **The section's landing page** is a `README.md` at the include's root; the other markdown files in a child directory render at their own paths.

- **Per tier:** every version tier stages the root from its own ref; a tag without the directory skips it with a notice, and the default branch must carry every configured root.

- **Key grammar:** `mount` is one or more lowercase URL segments joined by slashes (`skills`, `skills/agents`), `page` a plain markdown file name other than `index.md` or a dot-prefixed one, and no two roots share a `path` or a `mount`. Refused mounts: a locale-shaped name (`de`), a segment the site never walks (`node_modules`), `public/`.

- **One rule, two readers:** the plan refuses the same registration on every PR (one rule, [conventions.ts](../actions/pages-site/.vitepress/conventions.ts), read by both), so a root the deploy would misplace never reaches it. A child directory the site walks (neither dot-prefixed nor `node_modules`) carrying both the page and an `index.md` fails the build.

- **A `SKILL.md`-style page** with neither a `title` nor an h1 is titled by its `name` frontmatter key, its `description` becomes the meta description, and its "Edit this page" link names the real source path.

- **Links resolve from the page's own repository path:** `../repo-platform-sync-pr/SKILL.md` on a skill page is that skill's directory URL; `.codex-plugin/plugin.json` is the file on GitHub at the tier's ref.

## Turning the docs half off (`site.path: null`)

A repository whose own website already renders `docs/` (an Astro site serving it at `/docs/`, an MkDocs build of the same tree) has no use for the fleet's copy: the two would claim the same URLs, and `docs-check` would judge markdown by the fleet's link rules instead of the website's. One registration line turns the docs half off:

```yaml
site:
  path: null
```

| With `site.path: null` | Behavior |
|---|---|
| the deploy | publishes the hook's `dist` alone, whatever `docs/` carries; no `dist` means nothing published |
| `docs-check` | stands down with a notice on every PR (the job still runs, and passes) |
| `site.include` | refused by the plan: there is no docs mount to render the roots into |
| the plan's `config` output | `docs_path` is `null` |

The registration is read on every run, so the flip needs no sync. Use it when the website renders the docs itself: with `path: null` the hook's `dist` is the whole site, and an empty hook publishes nothing.

## The docs PR check

fleet-ci.yml's `docs-check` job builds `docs/` strictly on every pull request of a repository selecting `site` that carries a `docs/` directory (and has not turned the docs half off), with the same include roots the deploy reads from the registration, so a dead link fails the PR instead of the deploy.

- **A gating job:** it is one of the gating jobs behind `all-green`. The deploy would go red on the same link after the merge, and a job inside the `ci` call can never hang as an expected check the way a paths-filtered workflow could.

- **Every PR runs it:** a PR that changes no docs still runs it, quickly, over the unchanged tree.

- **The landing page:** a `docs/` without `docs/README.md` fails it, naming the missing landing page.

**Internal links** are checked across the whole assembled site by [lychee](https://github.com/lycheeverse/lychee), run offline by the same [lychee-action](https://github.com/lycheeverse/lychee-action) step and version as the nightly link-rot check, over the artifact laid out the way GitHub Pages serves it: an extensionless path is its `.html`, a directory is its `index.html`.

Every same-site link on a page built from the default branch must resolve, wherever the target lives (a website page into the docs, a docs page to a staged skill, a `#fragment` naming a heading, an emitted asset, a link spelled with the site's own URL).

A broken one fails the step with lychee's report, in the log and the job summary: one section per page, every failing link with its line and column and lychee's reason.

```text
### Errors in /home/runner/work/_temp/pages-site/served/repo/index.html

* [ERROR] <file:///home/runner/work/_temp/pages-site/served/repo/docs/skills/missing> (at 12:10) | File not found. Check if file exists and path is correct
* [ERROR] <file:///home/runner/work/_temp/pages-site/served/repo/docs/latest/skills/alpha#nope> (at 14:22) | Cannot find fragment
```

Where lychee reads a link differently from Pages:

| Link | lychee | Pages |
|---|---|---|
| inside `<pre>`, `<code>`, or a `<script src>` | not read (verbatim elements) | served |
| a `<meta http-equiv="refresh">` target | not read | followed |
| a `<meta content>` URL (`og:image`) | not read | fetched by the consumer |
| under a page's `<base href>` | resolved from the page's own path | resolved from the base |
| protocol-relative (`//host/path`) | read as a file path, so it fails; spell the scheme | fetched over the page's scheme |
| a page's URL with a trailing slash (`/setup/` for `setup.html`) | passes, through the extensionless fallback | 404 |

## Link rot

The nightly run checks the deployed site's EXTERNAL links after publishing with [lychee](https://github.com/lycheeverse/lychee) (internal ones are fatal at build time). The check runs on the schedule alone, so a fixed link closes the issue on the next clean night, never on a push.

**The issue:** findings ride the fleet's [tracking-issue stream](tracking-issues.md): one open issue under the label of the `labels.site` registration key (its default is the site module's `tracking_label` in `files.yml`), closed automatically on the first clean night. While it is open it holds releases on repositories with the release-please module; `release-override` is the escape hatch.

**The body** is lychee's report: a count table, then every failing URL with its status and the page and position linking it, grouped by page. A report past GitHub's issue body limit is cut at whole lines, naming how many are missing. A timed-out or rate-limited (429) request is retried three times before it counts, and one that keeps failing is reported under its own status.

| Skipped | Why |
|---|---|
| the theme's "Edit this page" links | theme output an anonymous crawl cannot judge (auth redirect, 404 on a private repository) |
| mail links | not http(s) |
| private-network and loopback URLs | not on the public network (`--exclude-all-private`) |
| same-site links and assets, relative or spelled with the site's own URL | judged against the artifact at build time, not over the network |
| URLs matching the repository's root `.lycheeignore` | the repository's own list of what an anonymous crawl cannot judge: hosts behind a bot wall (403) or a login redirect |

**`.lycheeignore`** is [lychee's own format](https://lychee.cli.rs/recipes/excluding-links/): one regular expression per line, `#` starting a comment. lychee reads it from its working directory alone, so the deploy copies the repository's copy into the assembled site after the Pages upload; the served site never carries it.

Keep it to hosts that are alive in a browser and reject automated clients, each with the reason: a broken link excluded there is never reported again.

## Module parameters (registration keys)

| Key in `.repo-platform.yml` | Meaning | Default |
|---|---|---|
| `site.path` | the URL segment the docs mount under when the hook also builds a website; `null` turns the docs half off ([above](#turning-the-docs-half-off-sitepath-null)) | `docs` (`modules.site.path` in `files.yml`) |
| `site.include` | extra source roots staged into the docs ([above](#other-roots-on-the-site-siteinclude)) | none |
| `labels.site` | the link-rot tracking issue's label | the site module's `tracking_label` default in [files.yml](../files.yml) |

**The `config` output:** the plan action ([actions/plan](../actions/plan/action.yml), mode `site`) resolves them on every run from the registration and the delivery commit's `files.yml` into one `config` output, the JSON document the pages-site action reads (`site_title`, `docs_path`, `include`, `link_rot_label` with its `link_rot_color` and `link_rot_description`). A caller without a registration passes the same document by hand, and its `site_title` must be non-empty like the registration's `project.name`.

## Pages enablement

Nothing to do: the module's settings layer creates the Pages site with Actions-workflow builds on the next fleet settings apply ([settings.md](settings.md)), which runs daily.

- **A deploy before that apply** skips its Pages steps and ends green with one warning (`no Pages site yet`): the job token can read the site but never create one. No manual toggle is needed, and no red run needs a rerun.
- **The nightly rebuild** deploys once the site exists; the next main push does the same.

**The `github-pages` environment needs no protection rule:** deploys never run on tag refs, and a required-reviewers rule there parks every deploy "waiting for review" with the later runs queued behind it on the `pages` lane. The settings apply does not manage environments, so remove such a rule by hand (Settings -> Environments -> github-pages).

## Caveats

- **One unversioned website:** the repository's website is one unversioned build of the judged commit; the `vX.Y.Z/` tiers exist only under the docs mount. A repository that wants versioned website builds puts them in its own hook output.

- **The hook's token:** the hook runs under the deploy job's token (`pages: write`, `id-token: write`, `issues: write`, the same exposure the release hooks have), so it runs only code from the judged commit.

- **A pre-existing hook:** a repository that already had its own `.github/actions/site-build/action.yml` keeps it (`unchanged` in the sync report); the fleet passes it `base-path` and `origin`, which an unrelated action may not declare. Check that it takes those two inputs and sets the `dist` output (the table above).

- **No landing page:** a repository with a `docs/` directory but no `docs/README.md` is red on every PR (`docs-check`) until the landing page exists, unless the docs half is off.

- **Private repositories:** serving Pages from a private repository requires a paid GitHub plan, and the served site is PUBLIC on non-Enterprise plans: selecting the module is the opt-in to that, per repository.

- **Prerelease tags:** prerelease-shaped tags (`v1.0.0-rc.1`) are not versions; only plain `vX.Y.Z` tags enter the version set.

- **One theme:** the theme is one for the whole fleet (dark by default with a light variant, one accent hue per repository derived from its name), owned by [actions/pages-site/.vitepress/theme/](../actions/pages-site/.vitepress/theme/README.md), which says which file controls what. Nothing is configured per repository, and the docs build strips the theme's remote font imports, so the docs never load a font from a third party (the hook's website is copied as built).
