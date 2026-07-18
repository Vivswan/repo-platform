# AGENTS.md

This file provides guidance to AI coding agents working in this repository.
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to this file, so edit only here.

## Project

repo-platform: a Copier template plus reusable GitHub Actions workflows and
composite actions that manage standards files across Vivswan's repositories.
Managed repos pull updates themselves (template-sync workflow); this repo
never pushes commits to them - a release only dispatches each repo's own
sync (propagate.yml).

## Layout

- `copier.yml` + `template/` are rendered into downstream repos. Files end
  in `.jinja`; conditional filenames gate emission by profile/visibility.
- `.github/workflows/reusable-*.yml` are called cross-repo by thin
  downstream callers pinned to release tags.
- `actions/` holds composite actions (check-typography, validate-template,
  validate-commit-names).
- `scripts/build_gitignore.py` generates `template/.gitignore.jinja` and
  this repo's own `.gitignore` from the latest github/gitignore;
  `scripts/gitignore.lock` records the SHA.
- `migrations/` holds copier `_migrations` scripts for breaking changes.
- `repos.yml` lists managed repos; `.github/workflows/propagate.yml`
  dispatches their template-sync on each release (push side of sync).

## Editing rules

- GitHub Actions expressions inside `.jinja` workflow files must be wrapped
  in `{% raw %}...{% endraw %}` or jinja eats the `{{ }}`.
- Never hand-edit `template/.gitignore.jinja`; run
  `python3 scripts/build_gitignore.py` (or `--locked` to regenerate from the
  recorded SHA). CI fails if it drifts from the lock (`--check`).
- Symlinks in `template/` (CLAUDE.md and friends) must stay symlinks;
  `.gitattributes` marks them `-text` and copier preserves them via
  `_preserve_symlinks`.
- The macOS gitignore section contains an intentional literal carriage
  return (`Icon[\r]`); `.typography-allow` exempts the file.
- Template changes reach downstream repos only through a release: merge to
  main, release-please cuts vX.Y.Z, repos pick it up on their next sync.

## Verification

- `uv run actions/validate-template/validate_generated_files.py --self .` validates this repo
  against its own conventions.
- Smoke-generate locally:
  `copier copy . /tmp/out --vcs-ref HEAD --defaults --trust -d project_name=X -d description=Y -d stack=python-uv -d profile=full -d private=false`
  then run the validator on `/tmp/out`. CI does this for all four
  stack/profile combos plus an upgrade-path test from the previous release.

## Conventions

- PR titles and commit subjects must be Conventional Commits; PRs are
  squash-merged and drive release-please versioning.
- CI gates on a single required check named `all-green`, which `needs:`
  every other job in `ci.yml`. When adding a CI job, add it to all-green's
  `needs` list.
- No typographic look-alike characters (curly quotes, em-dashes, invisible
  unicode); use plain ASCII punctuation. The check-typography action
  enforces this.
