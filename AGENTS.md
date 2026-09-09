<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here. Code is the source of truth; this file keeps only what the code cannot tell you.

## Project

repo-platform is a Copier template plus reusable GitHub Actions workflows and composite actions that manage standards files, CI, and settings across Vivswan's repositories.

## Architecture essentials

- This repo is the push-only operator: `sync-repos.yml` pushes sync PRs into managed repos and `settings-repos.yml` applies settings. Managed repos carry no sync workflow and no sync secret; the REPO_PLATFORM_TOKEN PAT lives only here.
- `templates/` is the source of truth: `base/` plus one folder per module, each with a `module.yml` manifest (loader: scripts/lib/module_manifests.ts). The composed `template/` tree is NOT committed on main; `bun run compose` writes a gitignored local copy.
- The orphan `build` branch is the generated delivery channel the fleet consumes (branch_tree.ts): copier.yml, the composed `template/`, `actions/`, and the fleet-facing reusable workflows. Fleet refs pin `@build`, never `@main`.
- Publishing the build branch is green-gated and provenance-verified: the post-green legs, including the `[fleet-sync: <scope>]` PR-body directive, are in docs/all-green.md; the trust model is in docs/build-provenance.md.
- Composition rules (gates, `{# compose:<name> #}` anchors, fragments, collisions, ownership classes): docs/compose.md. Fleet membership: the REPO_PLATFORM_TOKEN's repository grant, probed per repo (nothing in this repo lists the fleet). Module selection: each repo's `.repo-platform.yml`. Settings: the six-layer merge in docs/settings.md.

## Editing rules

- GitHub Actions expressions inside `.jinja` workflow files are wrapped in `{% raw %}...{% endraw %}`. Symlinks in `templates/base/` stay symlinks (`.gitattributes` marks them `-text`).
- Never hand-edit generated content; edit the source and run `bun run regen` (CI fails on drift). Exception: `bun scripts/generate/build_gitignore.ts` builds the gitignore outputs (networked; the refresh-gitignore workflow owns it) and `--topology` is its offline gate.
- Workflow run blocks longer than a few lines move to TypeScript under `.github/scripts/<owner>/`, run with bun, subprocesses as argv arrays via `shared/proc.ts`. `reusable-*` workflows that check out the CALLER's repository keep their steps inline.
- The `.sh` files under `.github/scripts/` are the bash exceptions (CI test harnesses independent of the code they verify, and release_freshness.sh, pinned to its template twin); `bun run lint:sh` shellchecks them.
- A template change that renames a rendered file, retires a repo-owned one, or flips its ownership class ships a migration ladder rung (a retired managed file needs none: the sync's retired-file cleanup deletes it): one self-contained `mNNNN_<slug>.ts` under `.github/scripts/sync/migrations/` (node:/bun: imports only), its unit test, its case in the upgrade-path harness (`.github/scripts/ci/upgrade_path_test.sh` and its `upgrade_path/` legs), and a PR-body note; docs/migrations.md is the contract. Rungs are permanent history and the sync carries no compatibility code outside them.
- Update the matching `docs/` guide when changing behavior it describes.

## Verification

- `bun run check` chains every local gate and bootstraps the root and per-action deps itself when a `node_modules` is missing (`bun run bootstrap` runs every frozen install on demand).
- Smoke-generate locally (main is not copier-consumable; copier needs bun on PATH): `bun .github/scripts/build-branches/branch_tree.ts --dest /tmp/bt`, then `git -C /tmp/bt init -b build && git -C /tmp/bt -c core.attributesFile=/dev/null -c core.autocrlf=false add -A --force && git -C /tmp/bt commit -m build`.
- Then `copier copy /tmp/bt /tmp/out --vcs-ref HEAD --defaults --trust -d project_name=X -d description=Y -d 'modules=[uv]' -d private=false` and run `bun actions/validate-template-report/validator/validate_generated_files.ts /tmp/out` (the validator is a script directory inside the report action, not an action of its own). The multiselect value must be a YAML list in ONE `-d` argument.

## Conventions

- PR titles and commit subjects are Conventional Commits, squash-merged. repo-platform runs no release pipeline of its own.
- `all-green` is the required check: ci.yml's own job, judged through actions/all-green (docs/all-green.md). A new gating job goes in `ALL_GREEN_ROSTER` in scripts/check/ssot/all_green.ts AND the all-green job's needs list.
- Plain ASCII punctuation (check-typography), and markdown prose is never hard-wrapped: one source line per paragraph or list item (`bun run wrap:check`).
<!-- END REPO-PLATFORM MANAGED -->
