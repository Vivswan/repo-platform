# The pages module

Selecting the `pages` module gives a repository a managed `pages.yml` workflow
that deploys GitHub Pages through repo-platform's `reusable-pages.yml`. One
Pages deployment carries up to two environments:

- the **production root** (`https://<owner>.github.io/<repo>/`), built from
  the latest release tag
- an optional **staging path** (`.../<repo>/staging/`), built from main HEAD

Staging refreshes on every push to main; the root changes only when a new
release is published. Before the first release there is no tag, so only
staging publishes and the root returns GitHub's default 404 - this is
intended, not a failure. With `pages_staging: false` there is nothing to
publish at all before the first release; those runs skip the deploy with a
notice and stay green.

## One-time setup

In the repository:

1. Settings -> Pages -> Source: **GitHub Actions**.
2. Settings -> Environments -> `github-pages` (created by the first deploy
   run) -> Deployment branches and tags -> add a **tag** rule `v*`. GitHub
   restricts the auto-created environment to the default branch, so without
   this rule the `release: published` trigger (which runs on the tag ref) is
   rejected with "not allowed to deploy to github-pages due to environment
   protection rules". Push-to-main and manual dispatch deploys work without
   it.

## Module parameters (copier questions)

| Question | Meaning | Default |
|---|---|---|
| `pages_setup` | Toolchain installed on the build runner (`bun`, `uv`, `none`) | `bun` if the bun module is selected, else `uv` if uv, else `none` |
| `pages_install_command` | Install step before each build (empty skips) | `bun install --frozen-lockfile` / `uv sync` / empty |
| `pages_build_command` | The build; must not be empty | `bun run build` / `uv run mkdocs build --site-dir dist` |
| `pages_dist_dir` | Build output directory | `dist` |
| `pages_production` | Root built from `release` (latest tag) or `main` (HEAD, no staging) | `release` |
| `pages_staging` | Publish main HEAD under `/staging/` | `true` |

## The build contract

The build command runs with three environment variables exported; map them
onto whatever your tool expects:

- `PAGES_BASE_PATH` - the base path the site is served under (`/<repo>/`,
  `/<repo>/staging/`, or `/` with a custom domain)
- `PAGES_ORIGIN` - the absolute origin (`https://<owner>.github.io` or
  `https://<domain>`), for sitemaps/canonical/og URLs
- `PAGES_STAGING` - `1` for the staging build, empty for production

Examples:

- Astro (bun): `ASTRO_BASE="$PAGES_BASE_PATH" ASTRO_SITE="$PAGES_ORIGIN" bun run build`
- Vite: `bun x vite build --base "$PAGES_BASE_PATH"`
- MkDocs (uv): `uv run mkdocs build --site-dir dist` (set `site_url` from
  `PAGES_ORIGIN`/`PAGES_BASE_PATH` in `mkdocs.yml` via an env plugin, or
  ignore them for path-relative sites)

## Custom domain

Three pieces have to agree; the repo variable only flips the build side:

1. **DNS**: point the domain at GitHub Pages (CNAME record to
   `<owner>.github.io` for a subdomain, or the Pages A/AAAA records for an
   apex domain).
2. **Pages settings**: Settings -> Pages -> Custom domain -> enter the
   domain (GitHub verifies DNS and provisions TLS here; the `CNAME` file in
   the artifact alone does not configure this for Actions-based deploys).
3. **Repo variable**: set `CUSTOM_DOMAIN` (Settings -> Secrets and variables
   -> Actions -> Variables), e.g. `example.com`. The next deploy then builds
   with the matching URLs: root moves from `/<repo>/` to `/`, staging to
   `/staging/`, `PAGES_ORIGIN` becomes `https://example.com`, and
   `_site/CNAME` is written.

To go back, undo all three (in particular, remove the variable AND clear the
custom domain in Pages settings together, or URLs and routing will disagree).

## Caveats

- Releases published by the default `GITHUB_TOKEN` (e.g. release-please
  without a PAT) do **not** fire `pages.yml`'s `release:` trigger - the same
  token caveat as propagate.yml. The next push to main or a manual
  `workflow_dispatch` picks the release up, since the root is re-resolved
  from the latest release on every run.
- Serving Pages from a private repository requires a paid GitHub plan; the
  workflow is unchanged either way, the deploy step simply fails on a free
  private repo.
- `pages_production: main` publishes main HEAD at the root and disables the
  staging path entirely.
