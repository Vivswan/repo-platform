# repo-platform

Pull-based standards management for [@Vivswan](https://github.com/Vivswan)'s
repositories: a [Copier](https://copier.readthedocs.io/) template plus
reusable GitHub Actions workflows and composite actions.

Managed repos pull template updates themselves. This repo never pushes
commits to them; a release only dispatches each repo's own sync workflow.

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
  questions only when selected.
- Channel `latest`: follows released `templates/vX.Y.Z` build tags;
  migrations run between releases.
- Channel `staging`: follows the staging branch head; migrations are
  skipped. Vivswan's own managed repos use it.

### Keeping repos in sync

- Every managed repo carries `template-sync.yml` (weekly cron plus manual
  dispatch): it runs `copier update`, validates the result, and opens a PR
  in the repo itself.
- Conflicts (local edits overlapping template changes) resolve in the
  template's favor: the dropped local lines are listed in the PR body, and
  every sync run fails until that PR is reviewed and merged.
- A release pushes too: `propagate.yml` dispatches every managed repo's
  sync immediately (registry: `repos.yml`), so the weekly pull is only the
  catch-all.
- Single repo: `gh workflow run propagate.yml -f repo=Vivswan/skills`.

### The sync token

Each managed repo should carry a `REPO_PLATFORM_TOKEN` Actions secret: a
fine-grained PAT
([create one with the permissions pre-selected](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=repo-platform+template+sync+and+settings-sync&contents=write&pull_requests=write&workflows=write&administration=write&issues=write)).

| Permission | Needed for |
|---|---|
| Contents:RW, Pull requests:RW | pushing the sync branch and opening its PR |
| Workflows:RW | updates that change `.github/workflows/` files |
| Administration:RW, Issues:RW | the settings-sync module |

Without the token, sync falls back to the default GITHUB_TOKEN:

- Sync PRs carry a close/reopen note (GITHUB_TOKEN cannot trigger CI).
- settings-sync runs skip with a notice.
- Updates that change workflow files fail with an error: GitHub never lets
  GITHUB_TOKEN push changes under `.github/workflows/`.

## Layout

| Path | Purpose |
|---|---|
| `templates/` | SOURCE of the template: one folder per module plus `base/`; shared files composed via `{# compose:<anchor> #}` markers + per-module `fragments/` |
| `copier.yml` | Questions + module choices (hand-maintained; standards-only, project skeletons come from `uv init` / `bun init`) |
| `.github/workflows/reusable-*.yml` | Reusable workflows: template-sync, pr-title, auto-assign, codeql, pages ([docs](docs/pages.md)), apply-settings ([docs](docs/settings.md)) |
| `actions/check-typography` | Blocks look-alike/invisible unicode (vendored from cloud-speech, config via `.typography-allow`) |
| `actions/validate-template` | Enforces markers, YAML validity, and the all-green convention |
| `actions/validate-commit-names` | Conventional Commit subjects on every push/PR commit |
| `scripts/build_gitignore.py` | Regenerates `templates/base/.gitignore.jinja` from the latest [github/gitignore](https://github.com/github/gitignore) (Windows + macOS + Linux always, Node/Python by bun/uv module) |
| `migrations/` | Copier `_migrations` scripts for future breaking changes |
| `docs/` | [all-green convention](docs/all-green.md), [new repo](docs/new-repo.md), [pages module](docs/pages.md), [settings-sync](docs/settings.md), [eject](docs/eject.md) |

## File ownership in managed repos

| Category | Files |
|---|---|
| Fully managed (template wins) | `.copier-answers.yml`, `.repo-platform.yml`, workflow callers, `dependabot.yml`, issue templates, `SECURITY.md`, `.yamllint`, agent-file symlinks |
| Managed + local sections | `.gitignore` (LOCAL section is yours) |
| Mergeable (three-way) | `.github/settings.yml`, `.github/CODEOWNERS`, `AGENTS.md`, `.editorconfig`, `.gitattributes` |
| Repo-owned (never touched) | `ci.yml` internals, source code, release tooling, everything else |

`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to the repo's `AGENTS.md` (the `agents` module, on by default): one
source of truth for agent instructions.

## Releasing

- [release-please](https://github.com/googleapis/release-please) accumulates
  [conventional commits](https://www.conventionalcommits.org) on `main` into
  a release PR; merging it tags `vX.Y.Z`, publishes the GitHub release, and
  updates `CHANGELOG.md`.
- Publishing the release rebuilds the `latest` branch (tagged
  `templates/vX.Y.Z`) and dispatches every managed repo's sync via
  `propagate.yml`.
- Latest-channel repos also pull weekly as a catch-all, or immediately via
  `gh workflow run template-sync.yml -R Vivswan/<repo>`; staging-channel
  repos pick up every merge to `main`.
