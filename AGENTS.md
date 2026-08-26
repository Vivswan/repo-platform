# AGENTS.md

This file provides guidance to AI coding agents working in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here. Code is the source of truth; this file keeps only what the code cannot tell you.

## Project

repo-platform: a Copier template plus reusable GitHub Actions workflows and composite actions that manage standards files across Vivswan's repositories. This repo is the push-only operator: `sync-repos.yml` runs copier against each managed repo and pushes a branch + PR into it; `settings-repos.yml` applies repository settings. Managed repos carry no sync workflow and no sync secret; the single REPO_PLATFORM_TOKEN PAT lives only here.

## Architecture essentials

- `templates/` is the SOURCE OF TRUTH: `base/` (unconditional files) plus one folder per module. The composed `template/` tree is NOT committed on main: the orphan `template` branch is a generated build output (build-branches.yml) that downstream repos consume. `bun run compose` writes a local gitignored `template/` for inspection.
- Composition rules (details in scripts/compose_template.ts's header): module files get filename gates, shared files take module contributions via `{# compose:<name> #}` anchors (free-form anchors splice `fragments/<name>.jinja`; list-shaped data anchors - dependabot ecosystems, codeql jobs and gate needs, gitleaks lockfiles - are generated from the module manifests, and per anchor either reject fragment files or consume fragments as generator input), and same-path collisions are errors. Each `templates/<module>/module.yml` manifest is the single source of module identity (scripts/module_manifests.ts is the loader).
- Fleet config (which repos) is `repos.yml`; module selection lives in each repo's own `.repo-platform.yml`; settings are a six-layer merge of plain settings-YAML documents (docs/settings.md), low to high: `.github/settings-baseline.yml`, the fleet visibility overlay, `templates/<module>/settings.yml`, the module visibility overlay, the repo's own `.github/settings.yml`, and `.github/settings-override.yml` - the top layer, which no repo can beat. `render_managed_settings.ts` selects and merges layers 1-4; `merge_settings_layers.ts` owns the dialect and adds 5 and 6. No settings content is derived from module.yml keys; the sole exception is a tracking label, whose name is a per-repo copier answer. `_skip_if_exists` in copier.yml is the generated-once-then-repo-owned list.

## Editing rules

- GitHub Actions expressions inside `.jinja` workflow files must be wrapped in `{% raw %}...{% endraw %}` or jinja eats the `{{ }}`.
- Never hand-edit generated content; edit its source and rerun its generator (CI fails on drift; `bun run regen` runs all four). From the module manifests via `bun run generate`: the marker-fenced regions in copier.yml, validate_generated_files.ts (the BASE_OWNERSHIP region there is sourced from templates/base/ownership.yml, the MODULE_OWNERSHIP region from the module.yml `ownership:` declarations), the docs, and the release-please templates' tracking-labels blocks, plus the whole templates/module.schema.json (the manifests' editor schema) and the toolchain version dotfiles (templates/<module>/<pin.file>, bumped by the refresh-toolchains workflow - docs/toolchains.md). From the templates + `.repo-platform-answers.yml` via `bun run dogfood`: this repo's copies of the files it dogfoods (the pair list is in scripts/render_dogfood.ts). From the manifests' `gitignore_sources` via `bun scripts/build_gitignore.ts --locked`: templates/base/.gitignore.jinja, the per-module `fragments/gitignore.jinja`, and this repo's `.gitignore` (plain mode, without `--locked`, also advances the upstream pin - that is the refresh-gitignore workflow's job, not routine regeneration). From the templates via `bun run renders` (needs copier on PATH): the golden render snapshots under tests/golden-renders/ (matrix and determinism contract in docs/golden-renders.md).
- Workflow run blocks longer than a few lines are extracted to TypeScript scripts under `.github/scripts/<owner>/`, run with bun; subprocesses use argv arrays via `shared/proc.ts`, never shell strings. Three scripts stay bash and shellcheck-linted: the ci/ test harnesses (upgrade_path_test, verify_smoke_gating), which must stay independent of the code they verify, and release_freshness.sh, pinned line-for-line to its inline template twin. Exception: `reusable-*` workflows whose primary checkout is the CALLER's repository, where this repo's scripts do not exist - their steps stay inline. reusable-template-sync checks out repo-platform itself (the target repo sits in a subdirectory), so it calls repo scripts normally.
- Symlinks in `templates/agents/` must stay symlinks (`.gitattributes` marks them `-text`; copier preserves them via `_preserve_symlinks`).
- A template change that renames a rendered file, retires one, or flips its ownership class MUST ship an upgrade_path_test.sh case for the transition and a PR-body note; the sync pipeline itself carries the transition (no version-gated migration system exists).
- Update the matching `docs/` guide when changing behavior it describes.

## Verification

- `bun run check` chains every local gate.
- Smoke-generate locally (main is not directly copier-consumable - build a scratch tree first; copier needs bun on PATH because the stamp hook runs with bun): `bun .github/scripts/build-branches/branch_tree.ts --dest /tmp/bt`, `git -C /tmp/bt init -b build && git -C /tmp/bt add -A && git -C /tmp/bt commit -m build`, `copier copy /tmp/bt /tmp/out --vcs-ref HEAD --defaults --trust -d project_name=X -d description=Y -d 'modules=[uv]' -d private=false` then run actions/validate-template on `/tmp/out`. The multiselect value must be a YAML list in ONE `-d` argument.

## Conventions

- PR titles and commit subjects are Conventional Commits, squash-merged; repo-platform runs no release pipeline of its own (managed repos that select the release-please module drive their own versioning from the same convention).
- CI gates on a single required check named `all-green`, which `needs:` every gating job in `ci.yml` - add new jobs to its `needs` list. The gate is strict: a skipped needed job counts as failure, so jobs stay unconditional and event conditions go on their steps.
- No typographic look-alike characters (curly quotes, em-dashes, invisible unicode); plain ASCII punctuation. check-typography enforces this.
- Markdown prose is never hard-wrapped: one source line per paragraph, list item, or quote paragraph. `bun run wrap:check` enforces this.
