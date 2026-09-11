---
order: 110
group: Modules
---

# Pages

Selecting the `pages` module arms the managed ci.yml's `pages` leg and lands a managed `pages.yml` workflow; both deploy ONE versioned GitHub Pages site through repo-platform's [reusable-pages.yml](../.github/workflows/reusable-pages.yml) and the shared [pages-site action](../actions/pages-site/action.yml). The repository's own build command produces the content; the pipeline owns versioning and layout. Callers pass only the commit to build and `vars.CUSTOM_DOMAIN`: the shared workflow's `config` job ([actions/plan](../actions/plan/action.yml), mode `pages`) reads the mounts, the toolchain setup, the build commands, the output directory, the site title, and the link-rot label from the repository's registration.

| URL | Built from | Content changes when |
|---|---|---|
| `https://<owner>.github.io/<repo>/` | the newest served version tag (none served - no tags yet, or all skipped: the default branch head, the same content as `latest/`) | a new version tag exists, or the pipeline or theme changes (every deploy rebuilds it; while none serve it follows the default branch head, so every deploy) |
| `.../<repo>/latest/` | the default branch head | every deploy |
| `.../<repo>/vX.Y.Z/` | that tag, one directory per served tag | the pipeline or theme changes (every deploy rebuilds all tiers; the source tag itself is immutable) |
| `.../<repo>/versions.json` | the version index (machine-readable) | the served tag set changes |

Versions are the repository's plain `vX.Y.Z` git tags - exactly what the release-please module tags releases with - newest first, the newest `PAGES_MAX_VERSIONS` of them (a repo Actions variable; unset means 5). Every deploy rebuilds every tier from scratch, so a pipeline or content fix restyles the whole site on the next run; the cost bound is `PAGES_MAX_VERSIONS + 2` builds per deploy (the served tags, `latest/`, and the root's own build: the newest served tag, or the default branch head while none serve).

The deploy runs three ways. On every push to the default branch it rides the managed ci.yml's run downstream of the `all-green` gate: the `pages` job calls reusable-pages.yml with the judged commit, so a red main never reaches the site ([all-green.md](all-green.md#after-the-gate)). pages.yml's nightly rebuild (04:23 UTC) and its manual dispatch build the default branch head. There is no tag trigger: a tag created without a push (a manual tag) lands on the nightly rebuild, or immediately via dispatch.

The `pages` job is ordered behind the release legs in the same run: it waits for the whole chain (release-please, the repo-owned release hooks, the publish) and then deploys whatever their result. When a version tag appears:

| What the release leg did on that push | The deploy | When the `vX.Y.Z/` tier and the new root appear |
| --- | --- | --- |
| Minted the tag and went green (the merge of a release PR) | Runs after it | That run's own deploy: the tag exists before the checkout reads the tag list. |
| Minted the tag, then a release hook or the publish failed | Runs after it | That run's own deploy, the same way: the tag is a git ref, published or not. |
| Failed before tagging, or was skipped (a red repo-owned post-green hook skips it) | Runs after it, no tag to serve | With the tag, once one exists: the next push, the nightly rebuild, or a dispatch. |
| No release leg (a tag pushed by hand, or no release-please module) | Unchanged | The nightly rebuild, or a dispatch. |

The ordering is an order, not a gate: the `pages` job carries `!cancelled()` beside the gate condition, so it never skips behind a failed or skipped release leg; without the release-please module the release legs skip and the deploy runs right after the gate.

## Pages enablement

Nothing to do: the pages module's settings layer enables Pages with Actions-workflow builds on the next fleet settings apply ([settings.md](settings.md)). Only a deploy that must run before that apply needs the manual toggle: Settings -> Pages -> Source: GitHub Actions. The `github-pages` environment needs no protection rule: deploys never run on tag refs, and a required-reviewers rule there parks every deploy "waiting for review" until the next run cancels it. The fleet settings apply does not manage environments, so remove such a rule by hand (Settings -> Environments -> github-pages).

## Module parameters (registration keys)

| Key in `.repo-platform.yml` | Meaning | Default |
|---|---|---|
| `pages.setup` | Toolchain(s) installed on the build runner (comma-separated `bun`/`node`/`deno`/`uv`/`rust`, or `none`) | every selected toolchain module joined with commas (e.g. `bun,node,deno,uv,rust`), else `none` |
| `pages.install` | Install step before each build (empty skips) | the install command of the first `pages.setup` toolchain in `files.yml` order (not the order typed) (`bun install --frozen-lockfile` / `npm ci` / `deno ci` / `uv sync` / `cargo +stable install mdbook --locked`), else empty |
| `pages.build` | The build; must not be empty | the build command of the first `pages.setup` toolchain in `files.yml` order (`bun run build` / `npm run build` / `deno task build` / `uv run mkdocs build --site-dir dist` / `mdbook build -d dist`) |
| `pages.dist` | Build output directory | `dist` (`modules.pages.dist` in `files.yml`) |

The plan action ([actions/plan](../actions/plan/action.yml)) resolves them on every run from the registration and the build branch's `files.yml`; a registration that sets none of them builds with the defaults.

## The build contract

The build command runs once per tier with four environment variables exported; map them onto whatever your tool expects:

- `PAGES_BASE_PATH`: the base path this tier is served under (`/<repo>/`, `/<repo>/latest/`, `/<repo>/vX.Y.Z/`, or the `/`-rooted equivalents with a custom domain)
- `PAGES_ORIGIN`: the absolute origin (`https://<owner>.github.io` or `https://<domain>`), for sitemaps/canonical/og URLs
- `PAGES_VERSION`: the content's version - `latest`, the tag (`vX.Y.Z`, also for the root tier, which builds the newest served tag), `latest` again for a root built while no tag serves, or empty for an unversioned mount (see the composed layout below)
- `PAGES_TIER`: the tier's place in the layout - `root` (the mount root), `latest`, `tag` (one `vX.Y.Z/` directory), or `single` (an unversioned mount's one build). The root is always a real page and the one copy to index: a site that avoids duplicate indexing marks every tier other than `root` and `single` `noindex`, and `PAGES_TIER` is what tells a root built from the default branch head apart from `latest/` (both read `latest` in `PAGES_VERSION`).

Examples:

- Astro (bun): `ASTRO_BASE="$PAGES_BASE_PATH" ASTRO_SITE="$PAGES_ORIGIN" bun run build`
- Vite: `bun x vite build --base "$PAGES_BASE_PATH"`
- MkDocs (uv): `uv run mkdocs build --site-dir dist` (set `site_url` from `PAGES_ORIGIN`/`PAGES_BASE_PATH` in `mkdocs.yml` via an env plugin, or ignore them for path-relative sites)
- mdBook (rust): `MDBOOK_OUTPUT__HTML__SITE_URL="$PAGES_BASE_PATH" mdbook build -d dist` (mdBook reads any `book.toml` key from the environment this way), or leave the site path-relative
- Anything else: `pages.setup: none` and an install command that fetches the tool (a Hugo or Zola release tarball, `gem install`); the pipeline sees only the command and its output directory

## With the docs-site module

Selecting `docs-site` alongside `pages` gives ONE Pages workflow: the website stays at `/` but becomes UNVERSIONED (one build of the default branch head - version navigation belongs to the docs), and the docs mount at `/<docs_site.path>/` (default `docs`) with the full tag rules one level down. The docs side's conventions live in [docs-site.md](docs-site.md).

## Internal links are checked across mounts

Once every mount is in place, the assembled artifact is crawled as one site, served the way GitHub Pages serves it: an extensionless path is its `.html`, a directory is its `index.html`. Every same-site link on a page (`.html` or `.htm`) built from the default branch head must resolve, wherever the target lives:

- a website page linking into `/<docs_site.path>/`
- a docs page linking to a skill rendered from another root
- a `#fragment` naming a heading that exists on the target page (`#top` in any letter case always does)
- an asset the build emitted
- a link spelled with the site's own URL (`https://<owner>.github.io/<repo>/...`); a sibling site of the same owner is external

A broken one fails the deploy (and the docs PR check, which runs the same gate over its one build) with a `page -> link (reason)` list, so a 404 never ships on a green run:

```text
broken internal links (page -> link):
  /repo/docs/latest/index.html -> /repo/docs/latest/skills/alpha/#nope (no element with id 'nope' on that page)
  /repo/index.html -> /repo/docs/skills/missing/ (status 404)
```

Pages inside version-tag tiers are valid targets but are not crawled: history cannot be fixed. External links stay the nightly link-rot check's business ([docs-site.md](docs-site.md#link-rot)).

## Custom domain

Three pieces have to agree; the repo variable only flips the build side:

1. DNS: point the domain at [GitHub Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site) (CNAME record to `<owner>.github.io` for a subdomain, or the Pages A/AAAA records for an apex domain).
2. Pages settings: Settings -> Pages -> Custom domain -> enter the domain (GitHub verifies DNS and provisions TLS here; the `CNAME` file in the artifact alone does not configure this for Actions-based deploys).
3. Repo variable: set `CUSTOM_DOMAIN` (Settings -> Secrets and variables -> Actions -> Variables), e.g. `example.com`. The next deploy then builds with the matching URLs: the root moves from `/<repo>/` to `/`, every tier follows, `PAGES_ORIGIN` becomes `https://example.com`, and the artifact carries `CNAME`.

To go back, undo all three (in particular, remove the variable AND clear the custom domain in Pages settings together, or URLs and routing will disagree).

## Caveats

- Historical tags build with TODAY'S build command and toolchain pins (the checkout's version dotfiles - see [toolchains.md](toolchains.md)); rust is the exception, since a tag's own `rust-toolchain.toml` overrides the runner's default inside that tag's tree. For a statically probeable command (`bun run <script>`, optionally with one plain-relative `--cwd` or one name-shaped `--filter` before the script), a tag is skipped with a notice and left out of `versions.json` when the package.json `bun run` resolves at that tag (the nearest one walking up from the command's cwd; for `--filter`: the workspace package of that name) does not declare the script, when the `--cwd` directory is absent, or when no package.json is reachable - and only when HEAD itself declares the script, so a command resolving through bun's other fallbacks (a dependency bin, a PATH executable) keeps building every kept tag; an install step that rewrites `package.json` at build time is not modeled. Any other command shape also builds every kept tag. A kept tag that declares the script but no longer builds still fails the whole deploy loudly; lower `PAGES_MAX_VERSIONS` below the broken tag's position, or fix the build command.
- Serving Pages from a private repository requires a paid GitHub plan, and the served site is PUBLIC on non-Enterprise plans - selecting the module is the opt-in to that.
- Prerelease-shaped tags (`v1.0.0-rc.1`) are not versions; only plain `vX.Y.Z` tags enter the version set.
