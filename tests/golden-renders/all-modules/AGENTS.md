<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by Vivswan/repo-platform and overwritten by template sync. This repository's own guidance goes below the END marker.

## Project

Golden Render: Golden render fixture

## Toolchain

- bun: `bun install`, `bun test`, `bun run <script>` (scripts in `package.json`)
- `.bun-version` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.
- Node.js with npm: `npm install`, `npm test`, `npm run <script>` (scripts in `package.json`)
- `.node-version` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.
- Deno: `deno install`, `deno test`, `deno task <task>` (tasks, imports, and lint/format settings in `deno.json`)
- `.dvmrc` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.
- Python with uv: `uv sync`, `uv run <command>` (metadata and dependencies in `pyproject.toml`)
- Rust with cargo: `cargo build`, `cargo test`, `cargo clippy` (crate layout and dependencies in `Cargo.toml`)

## Conventions

- PR titles and commit subjects are Conventional Commits; they drive release-please versioning. PRs are squash-merged, so the PR title becomes the commit subject. The `pr-title` check validates the title.
- CI gates on the `all-green` check, required by the managed ruleset. Under `.github/workflows/`, this repository's test and lint jobs go in `checks.yml`, its green-gated work on main in `post-green.yml` (both repo-owned); `ci.yml` is managed.
- A green push to main releases through the managed `release.yml`; this repository's release steps go in the repo-owned `update-release.yml` and `update-release-pr.yml` hooks.
- Plain ASCII punctuation only: no curly quotes, em-dashes, or invisible unicode. The check-typography gate enforces it.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform" arrive via sync PRs from that repository. Do not edit them here; change them there.
- Repository settings are applied from Vivswan/repo-platform's layers plus this repository's own `.github/settings.yml`. Edit that file, never the GitHub UI; the merge rules are in repo-platform's docs/settings.md.
- Repo-owned, never overwritten by sync: `checks.yml`, `post-green.yml`, `.gitleaks.toml`, `.gitignore` outside its managed region, `.typography-allow.local`, the release hooks and the release-please JSON files, the `.claude-plugin/` manifests.
- Module selection is the `modules` list in `.repo-platform.yml`; the next sync PR applies a change. The per-module contracts are in repo-platform's docs/new-repo.md.
- Fleet-wide conventions: repo-platform's docs/fleet-guidelines.md.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker; they are this repository's own and survive template updates. -->
<!-- END REPO-PLATFORM MANAGED -->
