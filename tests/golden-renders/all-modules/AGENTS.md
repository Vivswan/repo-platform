<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

This file provides guidance to AI coding agents working in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by Vivswan/repo-platform and overwritten by template sync; this repository's own guidance belongs outside the markers (below the END marker at the bottom).

## Project

Golden Render: Golden render fixture

## Toolchain

- Runtime and package manager: bun (`bun install`, `bun test`, `bun run <script>`)
- See `package.json` scripts for the available commands.
- `.bun-version` pins the toolchain and is managed by the template: sync overwrites it, so version overrides belong in the repo-owned workflows' explicit version inputs.
- Node.js with npm (`npm install`, `npm test`, `npm run <script>`)
- npm scripts in `package.json` are the command entry points.
- `.node-version` pins the toolchain and is managed by the template: sync overwrites it, so version overrides belong in the repo-owned workflows' explicit version inputs.
- Deno runtime (`deno install`, `deno test`, `deno task <task>`)
- See `deno.json` for tasks, imports (`npm:`/`jsr:` dependency specifiers), and lint/format settings.
- `.dvmrc` pins the toolchain and is managed by the template: sync overwrites it, so version overrides belong in the repo-owned workflows' explicit version inputs.
- Python managed with uv (`uv sync`, `uv run <command>`)
- See `pyproject.toml` for project metadata and dependencies.
- Rust managed with cargo (`cargo build`, `cargo test`, `cargo clippy`)
- See `Cargo.toml` for the workspace/crate layout and dependencies.

## Conventions

- PR titles and commit subjects must be Conventional Commits (`feat:`, `fix:`, `feat!:`, `chore:`, ...). PRs are squash-merged, so the PR title becomes the commit subject and drives release-please versioning. CI validates both (the required pr-title check + validate-commit-names).
- CI gates on the required check `all-green`: ci.yml's own `all-green` job needs the `checks` and `ci` caller jobs and fails unless each result is success or skipped, with at least one success (the gate jobs themselves run centrally through repo-platform's fleet-ci.yml; the `pr-title` check is required separately by its own ruleset). This repository's own test/lint jobs belong in `.github/workflows/checks.yml` (repo-owned, called inside the gate); do not edit ci.yml, template sync overwrites it. A green gate on a push to main releases: ci.yml's `release` job (`needs: [all-green]`, gated on its result) calls the managed release pipeline in `.github/workflows/release.yml` with the judged commit; this repository's release preparation (packaging, asset uploads, note edits) goes in the repo-owned `.github/workflows/update-release.yml` hook it calls.
- No typographic look-alike characters (curly quotes, em-dashes, invisible unicode). CI enforces this with the check-typography action; use plain ASCII punctuation.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform" arrive via sync PRs pushed by that repository. Do not edit them here; change them in Vivswan/repo-platform and let the next sync PR deliver the update.
- Repository settings (description, topics, labels, rulesets, merge policy) are applied from Vivswan/repo-platform: it merges the fleet defaults and this repository's selected-module layers at apply time, then this repository's own `.github/settings.yml` (identity keys and local overrides) over them, and finally a fleet override layer carrying the invariants no repository may weaken (squash-only merging, the branch protection rulesets). A same-name label here replaces the fleet one; a same-name ruleset merges, so you can tighten a fleet ruleset but not strip a rule from it. Do not change settings by hand in the GitHub UI; edit `.github/settings.yml`.
- Repo-owned escape hatches stay local: `.github/workflows/checks.yml`, `.github/workflows/update-release.yml`, `.github/workflows/update-release-pr.yml`, `release-please-config.json` and `.release-please-manifest.json` (release state, seeded once; force a version with a `Release-As: x.y.z` commit footer, never a `release-as` key - CI rejects the key because it outlives its release), `.gitleaks.toml`, `.gitignore` outside its BEGIN/END managed region, `.typography-allow.local` (typography exemptions; the managed `.typography-allow` is overwritten by sync), the `.claude-plugin/` manifests (plugin identity and the skill catalog, seeded once), and the repository-specific section below.
- Module selection is this repository's own: edit the `modules` list in `.repo-platform.yml` and the next sync PR applies the change.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker. They are this
     repository's own and survive template updates. -->
<!-- END REPO-PLATFORM MANAGED -->
