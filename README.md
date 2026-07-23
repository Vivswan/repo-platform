# repo-platform

Push-based standards management for [@Vivswan](https://github.com/Vivswan)'s
repositories: a [Copier](https://copier.readthedocs.io/) template plus
reusable GitHub Actions workflows and composite actions.

This repo pushes updates to managed repos: sync PRs and settings changes
originate here, and managed repos carry no sync workflow and no sync
secret. The one exception is the settings-sync module's optional
self-apply of a repo's own settings file.

## How it works

| Branch | Contents |
|---|---|
| `main` | Sources only (`templates/`, workflows, actions, scripts); NOT consumable by copier |
| `staging` | Generated build of the latest `main` commit (rebuilt on every push) |
| `latest` | Generated build of the latest release, tagged `templates/vX.Y.Z` |

`staging` and `latest` are orphan, append-only branches published by the
[build-branches workflow](.github/workflows/build-branches.yml):

- PRs against them are closed automatically, and a `main` history rewrite
  cannot invalidate them.
- `templates/` on main holds the sources; the composed tree that copier
  renders lands on the build branches.

### Modules and channels

- Modules (pick any combination): `agents`, `bun`, `uv`, `pages`,
  `release-please`, `issue-templates`, `pr-title`, `auto-assign`,
  `settings-sync`. Modules with parameters (like `pages`) ask follow-up
  questions only when selected. After generation, module selection lives in
  each repo's own `.repo-platform.yml`: edit its `modules:` list and the
  next sync applies the change.
- Channel `latest`: follows released `templates/vX.Y.Z` build tags;
  migrations run between releases.
- Channel `staging`: follows the staging branch head; migrations are
  skipped. Vivswan's own managed repos use it.
- Which channel a repo follows is fleet config: `defaults.channel` in
  [`repos.yml`](repos.yml), overridable per repo under `config:`.

### Keeping repos in sync

- The [sync-repos workflow](.github/workflows/sync-repos.yml) here runs on
  every release, on a weekly cron, and on manual dispatch. For each managed
  repo it runs `copier update`, validates the result, and pushes a branch +
  PR into the repo with the fleet PAT. PRs opened by a PAT trigger the
  target repo's CI and auto-assign normally.
- Clean updates arm squash auto-merge on the PR, so it merges itself once
  the repo's `all-green` check passes. A PR that needs review stays
  manual: auto-resolved conflicts, withheld workflow files, or failed
  validation.
- `repos.yml` decides which repos: a quoted `"*"` wildcard auto-discovers
  every owned, non-archived repo the PAT can WRITE to (granting the
  fleet PAT a repository is what enrolls it; fine-grained PATs can read
  every public repo, so read access alone means nothing), `exclude:` opts repos
  out, and a discovered repo is synced only once it carries
  `.repo-platform.yml` (unadopted repos are skipped with a notice).
- Conflicts (local edits overlapping template changes) resolve in the
  template's favor: the PR lists the dropped local lines for review. The
  run stays green (auto-resolution is normal operation); validation
  failures still turn it red.
- Recovery: when a repo's recorded `_commit` base is unusable (the sync
  fails with "no base to update from"), dispatch sync-repos with
  `repo=<owner/name>` and `recover=recopy`. That performs a full
  re-render with no three-way merge - local edits to template-managed
  files are overwritten (generated-once files and `.github/settings.yml`
  survive) - so it is single-repo only and the PR always stays
  manual-review.

### Repository settings

A repo's settings live in one of two homes, both applied from here by the
[settings-repos workflow](.github/workflows/settings-repos.yml) through
[repo-settings-as-code](https://github.com/Vivswan/repo-settings-as-code)
(details in [docs/settings.md](docs/settings.md)):

- Central: `settings/repos/<name>.yml` in this repo, with
  `settings/defaults.yml` deep-merged under every target.
- In-repo: the repo's own `.github/settings.yml` - carrying the file is
  the whole opt-in. The `settings-sync` module is optional sugar on top:
  it seeds the file and adds push-time self-apply.

A central file wins when both exist for the same repo, and the sync never
deletes a repo's `.github/settings.yml`.

### Credentials

One fine-grained PAT covers the whole fleet, stored ONLY in this repo as
the `REPO_PLATFORM_TOKEN` Actions secret
([create it with the permissions pre-selected](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=repo-platform+fleet%3A+push+sync+and+central+settings&contents=write&pull_requests=write&workflows=write&administration=write&issues=write)),
granted access to the managed repositories. Store it with
`gh secret set REPO_PLATFORM_TOKEN`.

Workflows RW is the only scope the machinery adapts to; the others are
hard requirements:

| Permission | Used for | Removing it |
|---|---|---|
| Contents:RW, Pull requests:RW | pushing sync branches and opening their PRs | sync legs fail with an actionable error |
| Workflows:RW | sync updates that change `.github/workflows/` files | workflow-file changes are withheld from the sync PR and listed in its body with a warning; everything else still lands |
| Administration:RW, Issues:RW | settings runs (fields, rulesets, labels) | settings runs fail: a section the token cannot reach must not hide drift behind a green run |

A missing secret is a misconfiguration of this repo: sync and settings
runs fail loudly with an error that carries the setup link. Dropping the
Workflows scope is the one supported narrowing; dropping anything else
turns runs red. Managed repos need no secret (the one exception: a
settings-sync module repo that wants to self-apply its settings on push
carries its own PAT; without one those runs skip with a warning and the
central apply covers the repo).

## Layout

| Path | Purpose |
|---|---|
| `templates/` | SOURCE of the template: one folder per module plus `base/`; shared files composed via `{# compose:<anchor> #}` markers + per-module `fragments/` |
| `copier.yml` | Questions + module choices (hand-maintained; standards-only, project skeletons come from `uv init` / `bun init`) |
| `repos.yml` | Fleet config: which repos are managed (wildcard + exclude) and which channel each follows |
| `settings/` | Central settings home: `defaults.yml` (shared baseline) + `repos/<name>.yml` per repo ([docs](docs/settings.md)) |
| `.github/workflows/sync-repos.yml` | Push sync fan-out: release + weekly cron + dispatch, one serialized run per repo |
| `.github/workflows/settings-repos.yml` | Central settings apply across the fleet |
| `.github/workflows/reusable-*.yml` | Reusable workflows: template-sync (the push-sync engine), auto-assign, codeql, pages ([docs](docs/pages.md)), apply-settings ([docs](docs/settings.md)) |
| `actions/check-typography` | Blocks look-alike/invisible unicode (vendored from cloud-speech, config via `.typography-allow` + repo-owned `.typography-allow.local`) |
| `actions/validate-template` | Enforces markers, YAML validity, and the all-green convention |
| `actions/validate-commit-names` | Conventional Commit subjects on every push/PR commit |
| `scripts/build_gitignore.ts` | Regenerates `templates/base/.gitignore.jinja` from the latest [github/gitignore](https://github.com/github/gitignore) (Windows + macOS + Linux always, Node/Python by bun/uv module) |
| `migrations/` | Copier `_migrations` scripts (TypeScript, run with bun) for breaking changes |
| `docs/` | [all-green convention](docs/all-green.md), [new repo](docs/new-repo.md), [pages module](docs/pages.md), [settings](docs/settings.md), [eject](docs/eject.md) |

## File ownership in managed repos

| Category | Files |
|---|---|
| Fully managed (template wins) | `.copier-answers.yml`, `ci.yml`, `release-please.yml`, workflow callers, `dependabot.yml`, issue templates, `SECURITY.md`, `.yamllint`, `.typography-allow`, agent-file symlinks |
| Managed shape, repo-owned selection | `.repo-platform.yml`: its presence marks the repo as participating in push sync, and its `modules:` list is the repo's own module selection (edit it; the next sync applies the change) |
| Managed + local sections | `.gitignore` (LOCAL section is yours) |
| Mergeable (three-way) | `.github/settings.yml` (seeded by the settings-sync module; never deleted by sync), `.github/CODEOWNERS`, `AGENTS.md`, `.editorconfig`, `.gitattributes` |
| Generated once, then repo-owned | `checks.yml` (your CI jobs, called inside the all-green gate), `release.yml` (your release pipeline around the managed release-please machinery), `auto-format.yml`, `copilot-setup-steps.yml`, `release-please-config.json`, `.release-please-manifest.json` |
| Repo-owned (never touched) | source code, release tooling, `.typography-allow.local`, everything else |

`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to the repo's `AGENTS.md` (the `agents` module, on by default): one
source of truth for agent instructions.

## Releasing

- [release-please](https://github.com/googleapis/release-please) accumulates
  [conventional commits](https://www.conventionalcommits.org) on `main` into
  a release PR; merging it tags `vX.Y.Z`, publishes the GitHub release, and
  updates `CHANGELOG.md`.
- Publishing the release rebuilds the `latest` branch (tagged
  `templates/vX.Y.Z`) and triggers `sync-repos.yml`, which pushes an update
  PR into every managed repo.
- The weekly sync-repos cron is the catch-all: it heals any missed release
  sync, and staging-channel repos pick up merges to `main` through it. For
  one repo immediately:
  `gh workflow run sync-repos.yml -f repo=Vivswan/<repo>`.
