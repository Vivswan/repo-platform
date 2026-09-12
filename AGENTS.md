# AGENTS.md

`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file. Code is the source of truth; this file holds only what the code cannot say.

## What this is

repo-platform manages standards files, CI, and settings across the owner's repositories: a file writer (`files.yml` + `files/`), reusable workflows, and composite actions, delivered to the fleet from the moving `stable` tag, which names a green main commit. Only this repository pushes to the fleet; managed repositories hold no sync workflow and no sync secret.

## Principles

- Repo-agnostic. Anything that serves one or two repositories belongs in those repositories, not here. Delete before adding. No compatibility code: repositories are migrated instead.
- Defensive. A repository that fails for a good reason fixes itself; the platform fails loudly and never bends a rule for it.
- One shape. One implementation per rule; a knob with one value is a constant; a special case is a parameter or it goes.
- Generated content is never hand-edited: edit the source and rerun the generator.
- Logic lives in TypeScript run with bun; shell is one command of glue in a `run:` step.
- A behavior change updates the `docs/` guide that describes it.

## Decisions to keep

- Sync triggers, in order of preference: the weekly schedule; a `[fleet-sync: <scope>]` directive as the first line of a merged PR body; a manual dispatch only when neither fits. Unsure which is right: ask the owner.
- The owner merges every PR of this repository.

## Where the contracts live

- What the fleet receives and how the writer applies it: docs/sync.md
- Gates, post-green legs, the PR-body directive: docs/all-green.md
- Delivery trust model: docs/build-provenance.md
- Settings layers: docs/settings.md
