# repo-platform

Pull-based standards management for [@Vivswan](https://github.com/Vivswan)'s
repositories: a [Copier](https://copier.readthedocs.io/) template plus
reusable GitHub Actions workflows and composite actions. Managed repos pull
template updates themselves; this repo never pushes to them.

## How it works

- `template/` is rendered into downstream repos by Copier
  (`stack: bun-ts | python-uv`, `profile: full | minimal`).
- Each managed repo carries a `template-sync.yml` workflow (weekly cron +
  manual dispatch). When a new release of this repo exists, it runs
  `copier update`, validates the result, and opens a PR **in its own repo**.
- With a `REPO_PLATFORM_TOKEN` secret (fine-grained PAT, Contents:RW +
  Pull requests:RW on that repo) the sync PR triggers CI normally; without
  it, the PR is created with the default `GITHUB_TOKEN` and carries a
  close/reopen note.
- Publishing a release here is passive: repos notice on their next sync.

## Layout

| Path | Purpose |
|---|---|
| `copier.yml` + `template/` | The Copier template (standards-only; project skeletons come from `uv init` / `bun init`) |
| `.github/workflows/reusable-*.yml` | Reusable workflows: template-sync, pr-title, auto-assign, codeql |
| `actions/check-typography` | Blocks look-alike/invisible unicode (vendored from cloud-speech, config via `.typography-allow`) |
| `actions/validate-template` | Enforces markers, YAML validity, and the all-green convention |
| `actions/validate-commit-names` | Conventional Commit subjects on every push/PR commit |
| `scripts/build_gitignore.py` | Regenerates `template/.gitignore.jinja` from the latest [github/gitignore](https://github.com/github/gitignore) (Windows + macOS + Linux always, Node/Python by stack) |
| `migrations/` | Copier `_migrations` scripts for future breaking changes |
| `docs/` | [all-green convention](docs/all-green.md), [new repo](docs/new-repo.md), [eject](docs/eject.md) |

## File ownership in managed repos

| Category | Files |
|---|---|
| Fully managed (template wins) | `.copier-answers.yml`, `.repo-platform.yml`, workflow callers, `dependabot.yml`, issue templates, `SECURITY.md`, `.yamllint`, agent-file symlinks |
| Managed + local sections | `.gitignore` (LOCAL section is yours) |
| Mergeable (three-way) | `.github/settings.yml`, `.github/CODEOWNERS`, `AGENTS.md`, `.editorconfig`, `.gitattributes` |
| Repo-owned (never touched) | `ci.yml` internals, source code, release tooling, everything else |

`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to the repo's `AGENTS.md`: one source of truth for agent
instructions.

## Releasing

Releases are cut by release-please: conventional commits on `main`
accumulate into a release PR; merging it tags `vX.Y.Z`, publishes the GitHub
release, and updates `CHANGELOG.md`. Managed repos pick the release up on
their next weekly sync, or immediately via
`gh workflow run template-sync.yml -R Vivswan/<repo>`.
