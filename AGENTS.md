# AGENTS.md

This file provides guidance to AI coding agents working in this repository.
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to this file, so edit only here. Code is the source of truth;
this file keeps only what the code cannot tell you.

## Project

repo-platform: a Copier template plus reusable GitHub Actions workflows and
composite actions that manage standards files across Vivswan's repositories.
This repo is the push-only operator: `sync-repos.yml` runs copier against
each managed repo and pushes a branch + PR into it; `settings-repos.yml`
applies repository settings. Managed repos carry no sync workflow and no
sync secret; the single REPO_PLATFORM_TOKEN PAT lives only here.

## Architecture essentials

- `templates/` is the SOURCE OF TRUTH: `base/` (unconditional files) plus
  one folder per module. The composed `template/` tree is NOT committed on
  main: the orphan `staging` and `latest` branches are generated build
  outputs (build-branches.yml; releases tag `templates/vX.Y.Z`), and
  downstream repos follow a `channel`. `bun run compose` writes a local
  gitignored `template/` for inspection.
- Composition rules (details in scripts/compose_template.ts's header):
  module files get filename gates, shared files take module contributions
  via `{# compose:<name> #}` anchors + `fragments/<name>.jinja`, and
  same-path collisions are errors.
- Fleet config (which repos, which channel) is `repos.yml`; module
  selection lives in each repo's own `.repo-platform.yml`; central
  settings live in `settings/`. `_skip_if_exists` in copier.yml is the
  generated-once-then-repo-owned list.

## Editing rules

- GitHub Actions expressions inside `.jinja` workflow files must be wrapped
  in `{% raw %}...{% endraw %}` or jinja eats the `{{ }}`.
- Never hand-edit generated files (templates/base/.gitignore.jinja, the
  `templates/{bun,uv,rust}/fragments/gitignore.jinja` fragments); run
  `bun scripts/build_gitignore.ts`. CI fails on drift.
- Workflow run blocks longer than a few lines are extracted to bash
  scripts under `.github/scripts/<owner>/` so shellcheck can lint them.
  Exception: the cross-repo `reusable-*` workflows run in the CALLER's
  checkout, where this repo's scripts do not exist - their steps stay
  inline.
- Symlinks in `templates/agents/` must stay symlinks (`.gitattributes`
  marks them `-text`; copier preserves them via `_preserve_symlinks`).
- Update the matching `docs/` guide when changing behavior it describes.

## Verification

- `bun run check` chains every local gate.
- Smoke-generate locally (main is not directly copier-consumable - build a
  scratch tree first; copier needs bun on PATH because `_migrations` runs
  with bun):
  `bun .github/scripts/build-branches/branch_tree.ts --dest /tmp/bt --channel staging`,
  `git -C /tmp/bt init -b build && git -C /tmp/bt add -A && git -C /tmp/bt commit -m build`,
  `copier copy /tmp/bt /tmp/out --vcs-ref HEAD --defaults --trust -d project_name=X -d description=Y -d 'modules=[uv]' -d private=false`
  then run actions/validate-template on `/tmp/out`. The multiselect value
  must be a YAML list in ONE `-d` argument.

## Conventions

- PR titles and commit subjects are Conventional Commits; squash merges
  drive release-please versioning.
- CI gates on a single required check named `all-green`, which `needs:`
  every gating job in `ci.yml` - add new jobs to its `needs` list. The gate
  is strict: a skipped needed job counts as failure, so jobs stay
  unconditional and event conditions go on their steps.
- No typographic look-alike characters (curly quotes, em-dashes, invisible
  unicode); plain ASCII punctuation. check-typography enforces this.
