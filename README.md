# repo-platform

Push-based standards management for [@Vivswan](https://github.com/Vivswan)'s repositories: a file writer plus reusable GitHub Actions workflows and composite actions.

Everything originates here. This repo pushes standards files into managed repos as PRs and applies their repository settings centrally; managed repos carry no sync workflow and no sync secret. The code is the source of truth for how any of it behaves, so this README stays at map level and points at the rest.

## Mental model

Sources on `main`, a moving `stable` tag, sync PRs into each repo:

- [files.yml](files.yml) is the file list and the module data: every path the platform writes, its ownership class, the condition it lands under, each module's data, the settings layers, and the fleet's mirrors ([docs/platform/sync/files.md](docs/platform/sync/files.md)).
- Every green `main` commit moves the `stable` tag, the one delivery channel; the written workflows pin `@stable` and read everything from that commit ([docs/platform/build-provenance.md](docs/platform/build-provenance.md)).
- [sync-repos.yml](.github/workflows/sync-repos.yml) copies the files at that commit into each managed repo as a PR, armed for auto-merge when nothing needs a human ([docs/platform/sync/operator.md](docs/platform/sync/operator.md)).
- Settings are rendered into every managed repo as a managed `.github/settings.yml` from the fleet layers and the repo's own overlay, and applied centrally ([docs/settings.md](docs/settings.md)).

## Design

The measure of the design is the cost of a simple change, not the number of checks.

| Principle                                                        | What it means here                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behavior never lives in a written file                           | ci.yml is byte-identical in every repo; fleet.yml's `plan` step reads the registration at run time and every leg keys on its outputs. Adding a leg is one static job in the skeleton plus its platform workflow.                                                                                                                                                     |
| Fewer derived artifacts beats a better generator                 | What the fleet receives is written once under `files/` and copied whole; the one rendered file is each repo's `.github/settings.yml`, folded by the sync from the settings layers and the repo's overlay. The generators that remain (gitignore blocks, toolchain pin dotfiles, the theme CSS, this repo's own settings document) each have one offline drift check. |
| One run, one order                                               | Everything after the gate is a job in the same run, ordered by `needs`: move the `stable` tag, sync the fleet, deploy the docs. No dispatch tokens between workflows.                                                                                                                                                                                                |
| Sync is copy, not merge                                          | Managed files are replaced whole, split files have their managed region replaced around the repository's own sides, starters are written once, and a file no entry writes any more is deleted when it still holds the platform's own content.                                                                                                                        |
| Private is private by where it runs and by what the run can emit | Job names carry row indexes, names are masked where they enter a step, per-row logs go to files, and the details land in the target repository ([docs/platform/sync/private-repositories.md](docs/platform/sync/private-repositories.md)).                                                                                                                           |
| Own as few files as possible                                     | Community health files come from the account's `.github` defaults repository; tool configs ride inside the actions that run them; the rest is the file list.                                                                                                                                                                                                         |
| TypeScript only                                                  | A workflow step is one `bun` call; [AGENTS.md](AGENTS.md#principles) owns the rule for the shell that stays.                                                                                                                                                                                                                                                         |

## Modules and onboarding

A repo picks any combination of modules in the `modules:` list of its own `.repo-platform.yml` (the roster is the `modules` section of [files.yml](files.yml)), and the next sync applies the change. Enrolling a repo is [docs/new-repo.md](docs/new-repo.md): scaffold with the native tool, commit a `.repo-platform.yml`, grant the fleet PAT access, and dispatch a sync that opens the first PR. The PAT's grant is the membership list.

## Shipping a change

Merge to `main`; once CI's `all-green` gate passes, the `stable` tag moves to the merged commit and the fleet picks it up on the next weekly sync. To sync right after the merge, put one `fleet-sync:` label on the PR before it merges; [docs/all-green.md](docs/all-green.md#opting-a-pr-into-an-immediate-fleet-sync) owns the labels and what a refused one does.

The dispatch `repo=` value ([fleet/sync_scope.ts](.github/scripts/fleet/sync_scope.ts) owns the grammar; settings-repos.yml's `repo=` reads the same):

| `repo=`                               | Syncs                                                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Vivswan/a,Vivswan/b`                 | those repos                                                                                                                         |
| `public` or `private`                 | every managed repo of that visibility                                                                                               |
| `modules:site+release-please`         | every managed repo whose `.repo-platform.yml` selects BOTH modules (`+` ANDs the names)                                             |
| `modules:site,modules:release-please` | every managed repo selecting EITHER module (filters union): the repos a change to the site or release-please files lands in         |
| `public,modules:site`                 | the public repos selecting site: a visibility token intersects with the filter, and a slug (`Vivswan/a,modules:site`) adds as typed |
| `all` or empty                        | the whole fleet                                                                                                                     |

- The filter, `private`, and slugs are dispatch-only, so a merge label carries `public` or `all` alone; [docs/all-green.md](docs/all-green.md#opting-a-pr-into-an-immediate-fleet-sync) says why.

## Credentials

One fine-grained PAT covers the whole fleet, stored ONLY in this repo as the `REPO_PLATFORM_TOKEN` secret of the `fleet-operator` environment, whose branch policy admits main runs alone.

1. [Create the token with the permissions pre-selected](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=repo-platform+fleet%3A+push+sync+and+central+settings&contents=write&pull_requests=write&workflows=write&administration=write&issues=write&actions=read&environments=write) and grant it access to the managed repositories.
2. Let the settings apply create the environment from [.github/settings.local.yml](.github/settings.local.yml); it reconciles the declaration on every run.
3. Store the token: `gh secret set REPO_PLATFORM_TOKEN --env fleet-operator`.

Every permission in that link is a hard requirement: a section the token cannot reach must not hide drift behind a green run.

- **Contents, Pull requests, Workflows, Administration, and Issues write** serve the sync and the settings apply; a `.github/workflows/` push GitHub refuses without Workflows write fails that repo's sync whole.
- **Actions read and Environments write** serve the `fleet-operator` environment the settings run reconciles.

Managed repos need no secret.

## Going deeper

- The guides, indexed by task and by page: [docs/README.md](docs/README.md).
- The file list and its grammar: [files.yml](files.yml) and [docs/platform/sync/files.md](docs/platform/sync/files.md#filesyml); the writer's code is under [.github/scripts/sync/writer](.github/scripts/sync/writer).
- Working in this repository, its conventions and principles: [AGENTS.md](AGENTS.md).
- [`skills/`](skills/README.md): portable agent skills for driving the platform from other repos, installed with `npx skills` and never synced to managed repos.
