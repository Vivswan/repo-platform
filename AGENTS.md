# AGENTS.md

`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here. Code is the source of truth; this file keeps only what the code cannot tell you.

## Project

repo-platform is a file writer plus reusable GitHub Actions workflows and composite actions that manage standards files, CI, and settings across Vivswan's repositories.

## Architecture essentials

- This repo is the push-only operator: `sync-repos.yml` pushes sync PRs into managed repos and `settings-repos.yml` applies settings. Managed repos carry no sync workflow and no sync secret; the REPO_PLATFORM_TOKEN PAT lives only here.
- `files.yml` is the source of truth for what the fleet receives (the grammar: actions/plan/files_config.ts, the contract: docs/sync.md); the sources under `files/` are copied whole by the writer in .github/scripts/sync/writer.
- The orphan `build` branch is the delivery channel the fleet consumes (branch_tree.ts assembles it). Fleet refs pin `@build`, never `@main`.
- Publishing the build branch is green-gated and provenance-verified: the post-green legs, including the `[fleet-sync: <scope>]` PR-body directive, are in docs/all-green.md; the trust model is in docs/build-provenance.md.
- Fleet membership: the REPO_PLATFORM_TOKEN's repository grant, probed per repo (nothing in this repo lists the fleet). Module selection and project facts: each repo's `.repo-platform.yml` (this repo carries its own, since the sync never targets it). Settings: the six-layer merge in docs/settings.md, rendered into each repo's `.github/settings.yml` by the sync.

## Editing rules

- Never hand-edit generated content; edit the source and rerun its generator (CI fails on drift): `bun run pins` writes the toolchain pin dotfiles from `files.yml`, `bun run theme` the pages theme CSS, `bun run settings` this repository's `.github/settings.yml` from the settings layers and `.github/settings.local.yml`, `bun scripts/files_table.ts --write docs/new-repo.md` the files table; `bun run regen` runs all four. `bun scripts/generate/build_gitignore.ts` builds the gitignore outputs (networked; the refresh-gitignore workflow owns it) and `--topology` is its offline gate.
- Workflow run blocks longer than a few lines move to TypeScript under `.github/scripts/<owner>/`, run with bun, subprocesses as argv arrays via `shared/proc.ts`. The reusable workflows that check out the CALLER's repository (fleet-ci.yml, `reusable-*`) keep their steps inline.
- No `.sh` files: shell lives only inline in `run:` steps, as one command or a few lines of glue around it (env, a loop over dirs, an exit-status or output check). The shell that stays shell: `actions/all-green`'s judge block, the bun-locating steps and their no-bun fallbacks in actions/bun-setup and actions/validate-managed-files, and the inline reusable-workflow steps above. CI harnesses are bun:test files under `tests/ci/` that reach the code under test only through subprocesses (the `ci-harness-imports` ssot rule pins it).
- A file the platform stops writing gets a `retired` entry in `files.yml` (the sync deletes it); a rename is a `retired` entry carrying `moved_to` for the old path plus the new entry. The one transitional path is the writer's cutover of pre-writer repositories (.github/scripts/sync/writer/cutover.ts), retired once every repository has crossed.
- Update the matching `docs/` guide when changing behavior it describes.

## Verification

- `bun run check` chains every local gate and bootstraps the root and per-action deps itself when a `node_modules` is missing (`bun run bootstrap` runs every frozen install on demand).
- To see what a repository would receive, run the writer against a scratch clone (docs/sync.md has the command); tests/ci/sync_end_to_end.test.ts is the end-to-end proof, and `bun run build:check` assembles the delivery tree into scratch.

## Conventions

- PR titles and commit subjects are Conventional Commits, squash-merged. repo-platform runs no release pipeline of its own.
- `all-green` is the required check: ci.yml's own job, judged through actions/all-green (docs/all-green.md). A new gating job goes in `ALL_GREEN_ROSTER` in scripts/check/ssot/all_green.ts AND the all-green job's needs list.
- Plain ASCII punctuation (check-typography), and markdown prose is never hard-wrapped: one source line per paragraph or list item (`bun run wrap:check`).
- repo-platform is repo-agnostic and prefers the simpler shape: a behavior, module, flag, or special case that serves only one or two fleet repositories belongs in those repositories (their hooks, starters, overlays, own workflows), not here, unless the owner says otherwise. Delete before adding; no compatibility code outside a migration (there is none today: repositories are migrated instead).
