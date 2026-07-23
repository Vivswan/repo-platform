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

- `templates/` is the SOURCE OF TRUTH: one folder per module (`agents`,
  `bun`, `uv`, `pages`, `release-please`, `issue-templates`, `pr-title`,
  `auto-assign`, `settings-sync`) plus `base/` (unconditional files; explicit conditional
  filenames like SECURITY.md's `not private` gate live only here). Files
  listed in copier.yml `_skip_if_exists` (checks.yml, release.yml,
  auto-format.yml, copilot-setup-steps.yml, the release-please
  config/manifest) are generated once and then repo-owned; everything else,
  including ci.yml, stays template-managed so sync can upgrade it.
- The composed `template/` tree is NOT committed on main: the `staging`
  and `latest` branches are generated, orphan, append-only build outputs
  (published by build-branches.yml, tagged `templates/vX.Y.Z` on latest;
  PRs against them auto-close). `bun run compose` writes a local
  gitignored `template/` for inspection only. Downstream repos follow a
  `channel` (Vivswan's own repos: staging).
- Module whole files get their `{% if '<module>' in modules %}` filename
  gate added by the composer. A module folder's optional `module.yml` can
  set `gate:` (custom gate expression) and `gate_dirs:` (a list of output
  directories gated once at the directory name instead of per-file leaf -
  see templates/issue-templates/module.yml). Additive contributions to
  shared files go through anchors: a skeleton in `base/` holds a full-line
  `{# compose:<name> #}` marker and modules supply
  `templates/<module>/fragments/<name>.jinja` (spliced in MODULE_ORDER,
  each wrapped in its module gate; fragments own all their whitespace).
- Collisions are ERRORS: the same path in two source folders refuses to
  compose - hoist the file to `base/` with an explicit gate or add an
  anchor. Exception: `templates/agents/AGENTS.md.jinja` keeps inline
  module gates (sub-line gates and a two-module wrapper that fragments
  cannot express).
- `.github/workflows/reusable-*.yml` are called cross-repo by thin
  downstream callers pinned to release tags.
- `actions/` holds composite actions (check-typography, validate-template,
  validate-commit-names).
- `scripts/build_gitignore.py` generates `templates/base/.gitignore.jinja`
  and this repo's own `.gitignore` from the latest github/gitignore;
  `scripts/gitignore.lock` records the SHA.
- `migrations/` holds copier `_migrations` scripts for breaking changes.
- `docs/` holds the human-facing guides: all-green convention, new-repo
  setup, pages module, settings-sync (token permissions), and eject. Update
  the matching doc when changing the behavior it describes.
- `repos.yml` lists managed repos; `.github/workflows/propagate.yml`
  dispatches their template-sync on each release (push side of sync).

## Editing rules

- GitHub Actions expressions inside `.jinja` workflow files must be wrapped
  in `{% raw %}...{% endraw %}` or jinja eats the `{{ }}`.
- Never hand-edit `templates/base/.gitignore.jinja` (generated); run
  `python3 scripts/build_gitignore.py` (or `--locked`). CI fails on drift.
  Scripts used only by CI/CD live in `.github/scripts/`.
- Symlinks in `templates/agents/` (CLAUDE.md and friends) must stay
  symlinks; `.gitattributes` marks them (and their composed copies) `-text`
  and copier preserves them via `_preserve_symlinks`.
- The macOS gitignore section contains an intentional literal carriage
  return (`Icon[\r]`); `.typography-allow` exempts both gitignore paths.
- Template changes reach staging-channel repos on every merge to main (the
  build-branches workflow rebuilds `staging`); latest-channel repos only
  through a release: release-please cuts vX.Y.Z, the builder tags
  `templates/vX.Y.Z`, repos pick it up on their next sync.

## Verification

- `uv run actions/validate-template/validate_generated_files.py --self .` validates this repo
  against its own conventions.
- Smoke-generate locally (main is not directly copier-consumable - build a
  scratch tree first):
  `uv run .github/scripts/build_branch_tree.py --dest /tmp/bt --channel staging`,
  `git -C /tmp/bt init -b build && git -C /tmp/bt add -A && git -C /tmp/bt commit -m build`,
  `copier copy /tmp/bt /tmp/out --vcs-ref HEAD --defaults --trust -d project_name=X -d description=Y -d 'modules=[uv]' -d private=false`
  then run the validator on `/tmp/out`. CI does this for five module
  combos plus an upgrade-path test across `templates/v*` build tags. The
  multiselect value must be a YAML list in ONE `-d` argument.
- `bun run check` chains every local gate, including `compose:check`
  (composition succeeds) and `gitignore:check`.

## Conventions

- PR titles and commit subjects must be Conventional Commits; PRs are
  squash-merged and drive release-please versioning.
- CI gates on a single required check named `all-green`, which `needs:`
  every other job in `ci.yml`. When adding a CI job, add it to all-green's
  `needs` list. Exception: the `release-please` job runs on top of the gate
  (`needs: all-green`), so releases only cut from a green main.
- No typographic look-alike characters (curly quotes, em-dashes, invisible
  unicode); use plain ASCII punctuation. The check-typography action
  enforces this.
