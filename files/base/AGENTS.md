# AGENTS.md

Guidance for AI coding agents in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by the platform and replaced on every sync. This repository's own guidance goes below the END marker.

## Project

{{project_name}}: {{description}}

## Conventions

- PR titles and commit subjects are Conventional Commits; PRs are squash-merged, so the PR title becomes the commit subject.
- CI gates on the `all-green` check. This repository's own jobs go in the repo-owned `checks.yml` (tests, lint) and `post-green.yml` (green-gated work on main); `ci.yml` is managed.
- Plain ASCII punctuation only; the check-typography gate enforces it.

## Managed by the platform

- A file whose header says "managed by {{github_username}}/repo-platform" arrives by sync PR. Change it there, never here.
- Repository settings come from `.github/settings.local.yml` (this repository's own) merged with the fleet layers into the rendered `.github/settings.yml`. Edit the local file, never the rendered one or the GitHub UI.
- Module selection is the `modules` list in `.repo-platform.yml`; the next sync applies a change. Contracts: the platform's docs/new-repo.md and docs/fleet-guidelines.md.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker; they are this repository's own and survive every sync. -->
