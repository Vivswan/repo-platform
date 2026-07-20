# repo-platform

Pull-based standards management for [@Vivswan](https://github.com/Vivswan)'s
repositories: a [Copier](https://copier.readthedocs.io/) template plus
reusable GitHub Actions workflows and composite actions. Managed repos pull
template updates themselves; this repo never pushes commits to them (a
release only *dispatches* each repo's own sync workflow).

## How it works

| Branch | Contents |
|---|---|
| `main` | Sources only (`templates/`, workflows, actions, scripts); NOT consumable by copier |
| `staging` | Generated build of the latest `main` commit (rebuilt on every push) |
| `latest` | Generated build of the latest release, tagged `templates/vX.Y.Z` |

`staging` and `latest` are orphan, append-only branches published by the
[build-branches workflow](.github/workflows/build-branches.yml); PRs against them are closed automatically, and a
`main` history rewrite cannot invalidate them.

- `templates/` on main holds the sources; the composed tree copier renders
  lands on the build branches. A repo picks any combination of feature
  **modules** (`agents`, `bun`, `uv`, `pages`, `release-please`,
  `issue-templates`, `pr-title`, `auto-assign`, `settings-sync`); modules
  with parameters (like `pages`) ask follow-up questions only when selected.
- Each repo also picks a **channel**: `latest` follows released
  `templates/vX.Y.Z` build tags (migrations run between releases);
  `staging` follows the staging branch head (migrations are skipped).
  Vivswan's own managed repos follow `staging`.
- Each managed repo carries a `template-sync.yml` workflow (weekly cron +
  manual dispatch). When its channel moved, it runs `copier update`,
  validates the result, and opens a PR in its own repo.
- Publishing a release also pushes: `propagate.yml` dispatches every
  managed repo's template-sync immediately (registry: `repos.yml`), so the
  weekly pull is only the catch-all. Selective manual push:
  `gh workflow run propagate.yml -f repo=Vivswan/skills`.
- With a `REPO_PLATFORM_TOKEN` secret ([fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token): Contents:RW,
  Pull requests:RW, plus Administration:RW and Issues:RW for the
  settings-sync module) the sync PR triggers CI normally and settings
  apply; without it, sync PRs carry a close/reopen note and settings-sync
  runs skip with a notice.

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

Releases are cut by [release-please](https://github.com/googleapis/release-please):
[conventional commits](https://www.conventionalcommits.org) on `main`
accumulate into a release PR; merging it tags `vX.Y.Z`, publishes the GitHub
release, and updates `CHANGELOG.md`. Publishing the release rebuilds the
`latest` branch (tagged `templates/vX.Y.Z`) and pushes to all managed repos
via `propagate.yml`; they also pull on their weekly sync as a catch-all, or
immediately via `gh workflow run template-sync.yml -R Vivswan/<repo>`.
Staging-channel repos pick up every merge to `main` instead.
