# repo-platform

Push-based standards management for [@Vivswan](https://github.com/Vivswan)'s repositories: a file writer plus reusable GitHub Actions workflows and composite actions.

Everything originates here. This repo pushes standards files into managed repos as PRs and applies their repository settings centrally; managed repos carry no sync workflow and no sync secret. The code is the source of truth for how any of it behaves, so this README stays at map level and points at the rest.

## Mental model

Sources on `main`, a moving `stable` tag, sync PRs into each repo:

- [files.yml](files.yml) is the file list: every path the platform writes, its ownership class (`managed`, `split`, `starter`), the module or visibility condition it lands under, and its source under `files/`.
- The same file holds each module's data (toolchain pin, dependabot ecosystems, gitignore sources, tracking label) in `modules`, the settings layers and the condition each lands under in `settings`, and the fleet's mirrors (the `AGENTS.md` symlinks) in `mirrors`, in the registration's grammar.
- Every green `main` commit moves the `stable` tag, the one delivery channel. The written workflows pin `@stable` and read `files.yml`, `files/`, `actions/`, and the reusable workflows straight from that commit, so every path is extraction-safe.
- [sync-repos.yml](.github/workflows/sync-repos.yml) copies the files at the `stable` commit into each managed repo on a dispatch, a labeled merge, or the weekly cron, then pushes a branch and PR into it with the fleet PAT ([docs/platform/sync/README.md](docs/platform/sync/README.md)).
- A report that holds nothing arms squash auto-merge, and the PR lands once that repo's `all-green` check passes. Anything a human should see (replaced local edits, a held retirement, a refused mirror, a registration note) stays for review.

Fleet settings are rendered into every managed repo as a managed `.github/settings.yml`, merged from the fleet layers and the repo's own `.github/settings.local.yml` starter. [settings-repos.yml](.github/workflows/settings-repos.yml) applies each rendered file in a github-settings-as-code job of its own; [docs/settings.md](docs/settings.md) owns the layers.

Which files the platform owns, and how strongly, is declared as data in `files.yml`, and every sync stamps the resulting map into the repo as `.github/repo-platform-manifest.json`, so a repo always carries the classification of its own files.

## Design

The measure of the design is the cost of a simple change, not the number of checks.

| Principle | What it means here |
|---|---|
| Behavior never lives in a written file | ci.yml is byte-identical in every repo; fleet-ci's `plan` step reads the registration at run time and every leg keys on its outputs. Adding a leg is one static job in the skeleton plus its platform workflow. |
| Fewer derived artifacts beats a better generator | What the fleet receives is written once under `files/` and copied whole; the one rendered file is each repo's `.github/settings.yml`, folded by the sync from the settings layers and the repo's overlay. The generators that remain (gitignore blocks, toolchain pin dotfiles, the theme CSS, this repo's own settings document) each have one offline drift check. |
| One run, one order | Everything after the gate is a job in the same run, ordered by `needs`: move the `stable` tag, sync the fleet, deploy the docs. No dispatch tokens between workflows. |
| Sync is copy, not merge | Managed files are replaced whole, split files have their managed region replaced around the repository's own sides, starters are written once, and a file no entry writes any more is deleted when it still holds the platform's own content. |
| Private is private by where it runs and by what the run can emit | Job names carry row indexes, names are masked where they enter a step, per-row logs go to files, and the details land in the target repository ([docs/platform/sync/private-repositories.md](docs/platform/sync/private-repositories.md)). |
| Own as few files as possible | Community health files come from the account's `.github` defaults repository; tool configs ride inside the actions that run them; the rest is the file list. |
| TypeScript only | A workflow step is one `bun` call; [AGENTS.md](AGENTS.md#principles) owns the rule for the shell that stays. |

## Modules

A repo picks any combination of modules in the `modules:` list of its own `.repo-platform.yml`, and the next sync applies the change. The roster is the `modules` section of [files.yml](files.yml).

## Onboarding a repo

Walkthrough: [docs/new-repo.md](docs/new-repo.md). The shape of it: scaffold with the native tool (`uv init`, `bun init`), commit a `.repo-platform.yml`, grant the fleet PAT access to the repo, and dispatch a sync that opens the first PR.

The fleet PAT's grant is the membership list, and [docs/new-repo.md](docs/new-repo.md#4-publish-and-grant-the-fleet-pat) owns enrolling a repo. Revoking the grant removes one, and archived repos and repos of another owner are left out.

## Shipping a change

Merge to `main`; once CI's `all-green` gate passes, the `stable` tag moves to the merged commit and the fleet picks it up on the next weekly sync. To sync right after the merge, put one `fleet-sync:` label on the PR before it merges; [docs/all-green.md](docs/all-green.md#opting-a-pr-into-an-immediate-fleet-sync) owns the labels and what a refused one does.

The dispatch `repo=` value ([fleet/sync_scope.ts](.github/scripts/fleet/sync_scope.ts) owns the grammar; settings-repos.yml's `repo=` reads the same):

| `repo=` | Syncs |
| --- | --- |
| `Vivswan/a,Vivswan/b` | those repos |
| `public` or `private` | every managed repo of that visibility |
| `modules:site+release-please` | every managed repo whose `.repo-platform.yml` selects BOTH modules (`+` ANDs the names) |
| `modules:site,modules:release-please` | every managed repo selecting EITHER module (filters union): the repos a change to the site or release-please files lands in |
| `public,modules:site` | the public repos selecting site: a visibility token intersects with the filter, and a slug (`Vivswan/a,modules:site`) adds as typed |
| `all` or empty | the whole fleet |

- A module name outside `files.yml` fails the plan before any repository is probed, naming the roster; a repo whose `.repo-platform.yml` has no readable `modules` list is reported as a warning and left out, and the plan prints how many repos the filter left out.
- The filter, `private`, and slugs are dispatch-only, so a merge label carries `public` or `all` alone; [docs/all-green.md](docs/all-green.md#opting-a-pr-into-an-immediate-fleet-sync) says why.

## Credentials

One fine-grained PAT covers the whole fleet, stored ONLY in this repo as the `REPO_PLATFORM_TOKEN` secret of the `fleet-operator` environment, whose branch policy admits main runs alone.

1. [Create the token with the permissions pre-selected](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=repo-platform+fleet%3A+push+sync+and+central+settings&contents=write&pull_requests=write&workflows=write&administration=write&issues=write&actions=read&environments=write) and grant it access to the managed repositories.
2. Let the settings apply create the environment from [.github/settings.local.yml](.github/settings.local.yml); it reconciles the declaration on every run.
3. Store the token: `gh secret set REPO_PLATFORM_TOKEN --env fleet-operator`.

Every permission in that link is a hard requirement. A section the token cannot reach must not hide drift behind a green run, so a missing one fails the leg loudly with GitHub's error and nothing is delivered partially.

- **Contents, Pull requests, Workflows, Administration, and Issues write** serve the sync and the settings apply; a `.github/workflows/` push GitHub refuses without Workflows write fails that repo's sync whole.
- **Actions read and Environments write** serve the `fleet-operator` environment the settings run reconciles.

A missing secret is a misconfiguration of this repo, and the failure carries the setup link.

Managed repos need no secret.

## Going deeper

- The guides, indexed by task and by page: [docs/README.md](docs/README.md).
- The file list and its grammar: [files.yml](files.yml) and [docs/platform/sync/files.md](docs/platform/sync/files.md#filesyml); the writer's code is under [.github/scripts/sync/writer](.github/scripts/sync/writer).
- Working in this repository, its conventions and principles: [AGENTS.md](AGENTS.md).
- [`skills/`](skills/README.md): portable agent skills for driving the platform from other repos, installed with `npx skills` and never synced to managed repos.
