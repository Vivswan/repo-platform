# The pages module

Selecting the `pages` module gives a repository a managed `pages.yml` workflow that deploys ONE versioned GitHub Pages site through repo-platform's [reusable-pages.yml](../.github/workflows/reusable-pages.yml) and the shared [pages-site action](../actions/pages-site/action.yml). The repository's own build command produces the content; the pipeline owns versioning and layout.

| URL | Built from | Content changes when |
|---|---|---|
| `https://<owner>.github.io/<repo>/` | the newest version tag (before the first tag: a redirect to `latest/`) | a new version tag exists |
| `.../<repo>/latest/` | the default branch head | every deploy |
| `.../<repo>/vX.Y.Z/` | that tag, one directory per kept tag | the pipeline or theme changes (every deploy rebuilds all tiers; the source tag itself is immutable) |
| `.../<repo>/versions.json` | the version index (machine-readable) | the tag set changes |

Versions are the repository's plain `vX.Y.Z` git tags - exactly what the release-please module tags releases with - newest first, the newest `PAGES_MAX_VERSIONS` of them (a repo Actions variable; unset means 5). Every deploy rebuilds every tier from scratch, so a pipeline or content fix restyles the whole site on the next run; the cost bound is `PAGES_MAX_VERSIONS + 2` builds per deploy (the kept tags, `latest/`, and the root's own build of the newest tag).

The workflow deploys on every push to the default branch, nightly (04:23 UTC), and on manual dispatch. There is no tag trigger: a tag created without a push (release-please publishing, a manual tag) lands on the nightly rebuild, or immediately via dispatch.

## One-time setup

With the settings-sync module selected: nothing - the pages module's settings layer enables Pages with Actions-workflow builds on the next apply ([settings.md](settings.md)).

Without it: Settings -> Pages -> Source: GitHub Actions. No `github-pages` environment tag rule is needed anymore - deploys never run on tag refs.

## Module parameters (copier questions)

| Question | Meaning | Default |
|---|---|---|
| `pages_setup` | <!-- BEGIN GENERATED: pages-setup-meaning (scripts/generate.ts - edit module.yml manifests, not this block) -->Toolchain(s) installed on the build runner (comma-separated `bun`/`node`/`deno`/`uv`, or `none`)<!-- END GENERATED: pages-setup-meaning --> | <!-- BEGIN GENERATED: pages-setup-default (scripts/generate.ts - edit module.yml manifests, not this block) -->every selected toolchain module joined with commas (e.g. `bun,node,deno,uv`), else `none`<!-- END GENERATED: pages-setup-default --> |
| `pages_install_command` | Install step before each build (empty skips) | <!-- BEGIN GENERATED: pages-install-default (scripts/generate.ts - edit module.yml manifests, not this block) -->`bun install --frozen-lockfile` / `npm ci` / `deno ci` / `uv sync` / empty<!-- END GENERATED: pages-install-default --> |
| `pages_build_command` | The build; must not be empty | <!-- BEGIN GENERATED: pages-build-default (scripts/generate.ts - edit module.yml manifests, not this block) -->`bun run build` / `npm run build` / `deno task build` / `uv run mkdocs build --site-dir dist`<!-- END GENERATED: pages-build-default --> |
| `pages_dist_dir` | Build output directory | `dist` |

The retired `pages_production` and `pages_staging` answers have no replacement: the tag rules above are the one behavior, and whether a repository has version tags decides what the root serves.

## The build contract

The build command runs once per tier with three environment variables exported; map them onto whatever your tool expects:

- `PAGES_BASE_PATH`: the base path this tier is served under (`/<repo>/`, `/<repo>/latest/`, `/<repo>/vX.Y.Z/`, or the `/`-rooted equivalents with a custom domain)
- `PAGES_ORIGIN`: the absolute origin (`https://<owner>.github.io` or `https://<domain>`), for sitemaps/canonical/og URLs
- `PAGES_VERSION`: what this tier is - `latest`, the tag (`vX.Y.Z`, also for the root tier, which builds the newest tag), or empty for an unversioned mount (see the composed layout below)

Examples:

- Astro (bun): `ASTRO_BASE="$PAGES_BASE_PATH" ASTRO_SITE="$PAGES_ORIGIN" bun run build`
- Vite: `bun x vite build --base "$PAGES_BASE_PATH"`
- MkDocs (uv): `uv run mkdocs build --site-dir dist` (set `site_url` from `PAGES_ORIGIN`/`PAGES_BASE_PATH` in `mkdocs.yml` via an env plugin, or ignore them for path-relative sites)

## With the docs-site module

Selecting `docs-site` alongside `pages` renders ONE Pages workflow: the website stays at `/` but becomes UNVERSIONED (one build of the default branch head - version navigation belongs to the docs), and the docs mount at `/<docs_site_path>/` (default `docs`) with the full tag rules one level down. The docs side's conventions live in [docs-site.md](docs-site.md).

## Custom domain

Three pieces have to agree; the repo variable only flips the build side:

1. DNS: point the domain at [GitHub Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site) (CNAME record to `<owner>.github.io` for a subdomain, or the Pages A/AAAA records for an apex domain).
2. Pages settings: Settings -> Pages -> Custom domain -> enter the domain (GitHub verifies DNS and provisions TLS here; the `CNAME` file in the artifact alone does not configure this for Actions-based deploys).
3. Repo variable: set `CUSTOM_DOMAIN` (Settings -> Secrets and variables -> Actions -> Variables), e.g. `example.com`. The next deploy then builds with the matching URLs: the root moves from `/<repo>/` to `/`, every tier follows, `PAGES_ORIGIN` becomes `https://example.com`, and the artifact carries `CNAME`.

To go back, undo all three (in particular, remove the variable AND clear the custom domain in Pages settings together, or URLs and routing will disagree).

## Caveats

- Historical tags build with TODAY'S build command and toolchain pins (the checkout's version dotfiles - see [toolchains.md](toolchains.md)). A kept tag whose tree no longer builds fails the whole deploy loudly; lower `PAGES_MAX_VERSIONS` below the broken tag's position, or fix the build command.
- Serving Pages from a private repository requires a paid GitHub plan, and the served site is PUBLIC on non-Enterprise plans - selecting the module is the opt-in to that.
- Prerelease-shaped tags (`v1.0.0-rc.1`) are not versions; only plain `vX.Y.Z` tags enter the version set.
