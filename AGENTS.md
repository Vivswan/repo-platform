<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

Guidance for AI coding agents in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by the platform and replaced on every sync. This repository's own guidance goes below the END marker.

## Project

repo-platform: Standards files, CI, and settings for Vivswan's repositories, pushed from one place

## Conventions

- PR titles and commit subjects are Conventional Commits; PRs are squash-merged, so the PR title becomes the commit subject.
- CI gates on the `all-green` check. This repository's own jobs go in the repo-owned `checks.yml` (tests, lint) and `post-green.yml` (green-gated work on main); `ci.yml` is managed.
- Plain ASCII punctuation only; the check-typography gate enforces it.

## Managed by the platform

- A file whose header says "managed by Vivswan/repo-platform" arrives by sync PR. Change it there, never here.
- Repository settings come from `.github/settings.local.yml` (this repository's own) merged with the fleet layers into the rendered `.github/settings.yml`. Edit the local file, never the rendered one or the GitHub UI.
- Module selection is the `modules` list in `.repo-platform.yml`; the next sync applies a change. Contracts: the platform's docs/new-repo.md and docs/fleet-guidelines.md.

## Toolchain

- bun: `bun install`, `bun test`, `bun run <script>` (scripts in `package.json`)
- `.bun-version` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker; they are this repository's own and survive every sync. -->
<!-- END REPO-PLATFORM MANAGED -->

Code is the source of truth; this file holds only what the code cannot say.

### What this is

repo-platform manages standards files, CI, and settings across the owner's repositories: a file writer (`files.yml` + `files/`), reusable workflows, and composite actions, delivered to the fleet from the moving `stable` tag, which names a green main commit. Only this repository pushes to the fleet; managed repositories hold no sync workflow and no sync secret. It is a sync target of itself: the writer keeps its root copies of the files it ships, and the paths its `.repo-platform.yml` excepts (its own `ci.yml` among them) are its own.

### Principles

- Repo-agnostic. Anything that serves one or two repositories belongs in those repositories, not here. Delete before adding. No compatibility code: repositories are migrated instead.
- Defensive. A repository that fails for a good reason fixes itself; the platform fails loudly and never bends a rule for it.
- One shape. One implementation per rule; a knob with one value is a constant; a special case is a parameter or it goes.
- Generated content is never hand-edited: edit the source and rerun the generator.
- Logic lives in TypeScript run with bun; shell is one command of glue in a `run:` step.
- A behavior change updates the `docs/` guide that describes it.

### Decisions to keep

- Sync triggers, in order of preference: the weekly schedule; a `fleet-sync:public` or `fleet-sync:all` label on the merged PR; a manual dispatch only when neither fits. Unsure which is right: ask the owner.

### Where the contracts live

- What the fleet receives and how the writer applies it: docs/sync.md
- Gates, post-green legs, the fleet-sync label: docs/all-green.md
- Delivery trust model: docs/build-provenance.md
- Settings layers: docs/settings.md
