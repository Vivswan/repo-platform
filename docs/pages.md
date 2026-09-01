# The pages module

Selecting the `pages` module gives a repository a managed `pages.yml` workflow that deploys GitHub Pages through repo-platform's [reusable-pages.yml](../.github/workflows/reusable-pages.yml). One Pages deployment carries up to two environments:

| Environment | URL | Built from | Content changes when |
|---|---|---|---|
| production root | `https://<owner>.github.io/<repo>/` | the latest release tag | a new release is published |
| staging (optional) | `.../<repo>/staging/` | main HEAD | every push to main |

The table shows the default `pages_production: release` mode; `pages_production: main` builds the root from main HEAD and disables staging (see [caveats](#caveats)). The workflow runs on every push to main, on every published release, and on manual dispatch, and each run re-resolves the root from the latest release - so any run can pick up a release the `release:` trigger missed.

Before the first release there is no tag, so only staging publishes and the root returns GitHub's default 404. This is intended, not a failure. With `pages_staging: false` there is nothing to publish at all before the first release; those runs skip the deploy with a notice and stay green.

## One-time setup

In the repository:

1. Settings -> Pages -> Source: GitHub Actions.
2. Settings -> Environments -> `github-pages` (created by the first deploy run) -> Deployment branches and tags -> add a tag rule `v*`. GitHub restricts the auto-created environment to the default branch, so without this rule the `release: published` trigger (which runs on the tag ref) is rejected with "not allowed to deploy to github-pages due to environment protection rules". Push-to-main and manual dispatch deploys work without it.

## Module parameters (copier questions)

| Question | Meaning | Default |
|---|---|---|
| `pages_setup` | <!-- BEGIN GENERATED: pages-setup-meaning (scripts/generate.ts - edit module.yml manifests, not this block) -->Toolchain(s) installed on the build runner (comma-separated `bun`/`node`/`deno`/`uv`, or `none`)<!-- END GENERATED: pages-setup-meaning --> | <!-- BEGIN GENERATED: pages-setup-default (scripts/generate.ts - edit module.yml manifests, not this block) -->every selected toolchain module joined with commas (e.g. `bun,node,deno,uv`), else `none`<!-- END GENERATED: pages-setup-default --> |
| `pages_install_command` | Install step before each build (empty skips) | <!-- BEGIN GENERATED: pages-install-default (scripts/generate.ts - edit module.yml manifests, not this block) -->`bun install --frozen-lockfile` / `npm ci` / `deno ci` / `uv sync` / empty<!-- END GENERATED: pages-install-default --> |
| `pages_build_command` | The build; must not be empty | <!-- BEGIN GENERATED: pages-build-default (scripts/generate.ts - edit module.yml manifests, not this block) -->`bun run build` / `npm run build` / `deno task build` / `uv run mkdocs build --site-dir dist`<!-- END GENERATED: pages-build-default --> |
| `pages_dist_dir` | Build output directory | `dist` |
| `pages_production` | Root built from `release` (latest tag) or `main` (HEAD, no staging) | `release` |
| `pages_staging` | Publish main HEAD under `/staging/` | `true` |

## The build contract

The build command runs with three environment variables exported; map them onto whatever your tool expects:

- `PAGES_BASE_PATH`: the base path the site is served under (`/<repo>/`, `/<repo>/staging/`, or `/` with a custom domain)
- `PAGES_ORIGIN`: the absolute origin (`https://<owner>.github.io` or `https://<domain>`), for sitemaps/canonical/og URLs
- `PAGES_STAGING`: `1` for the staging build, empty for production

Examples:

- Astro (bun): `ASTRO_BASE="$PAGES_BASE_PATH" ASTRO_SITE="$PAGES_ORIGIN" bun run build`
- Vite: `bun x vite build --base "$PAGES_BASE_PATH"`
- MkDocs (uv): `uv run mkdocs build --site-dir dist` (set `site_url` from `PAGES_ORIGIN`/`PAGES_BASE_PATH` in `mkdocs.yml` via an env plugin, or ignore them for path-relative sites)

## Custom domain

Three pieces have to agree; the repo variable only flips the build side:

1. DNS: point the domain at [GitHub Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site) (CNAME record to `<owner>.github.io` for a subdomain, or the Pages A/AAAA records for an apex domain).
2. Pages settings: Settings -> Pages -> Custom domain -> enter the domain (GitHub verifies DNS and provisions TLS here; the `CNAME` file in the artifact alone does not configure this for Actions-based deploys).
3. Repo variable: set `CUSTOM_DOMAIN` (Settings -> Secrets and variables -> Actions -> Variables), e.g. `example.com`. The next deploy then builds with the matching URLs: root moves from `/<repo>/` to `/`, staging to `/staging/`, `PAGES_ORIGIN` becomes `https://example.com`, and `_site/CNAME` is written.

To go back, undo all three (in particular, remove the variable AND clear the custom domain in Pages settings together, or URLs and routing will disagree).

## Caveats

- Releases published by the default `GITHUB_TOKEN` (e.g. [release-please](https://github.com/googleapis/release-please) without a PAT) do not fire `pages.yml`'s `release:` trigger. The next push to main or a manual `workflow_dispatch` picks the release up, since the root is re-resolved from the latest release on every run.
- Serving Pages from a private repository requires a paid GitHub plan; the workflow is unchanged either way, the deploy step simply fails on a free private repo.
- `pages_production: main` publishes main HEAD at the root and disables the staging path entirely.
- The setup steps install the fleet-pinned toolchain version when the built source carries its version dotfile (`.bun-version` / `.node-version` / `.dvmrc` - see [toolchains.md](toolchains.md)), preferring the production tree's pin over staging's; without the dotfile they float on the setup action's default.
