# repo-platform

Push-based standards management for [@Vivswan](https://github.com/Vivswan)'s repositories: a file writer plus reusable GitHub Actions workflows and composite actions.

Everything originates here. This repo pushes standards files into managed repos as PRs and applies their repository settings centrally; managed repos carry no sync workflow and no sync secret. The code is the source of truth for how any of it behaves, so this README stays at map level and points at the rest.

## Mental model

Sources on `main`, a published build branch, sync PRs into each repo:

- [files.yml](files.yml) is the file list: every path the platform writes, its ownership class (`managed`, `split`, `starter`, `link`), the module or visibility condition it lands under, and its source under `files/`. The `modules` section holds each module's data (toolchain pin, dependabot ecosystems, gitignore sources, settings layers, tracking label).
- Every green `main` commit rebuilds the orphan `build` branch, the one delivery channel: `files.yml` and `files/` for the writer, `actions/` for the composite actions the written workflows pin `@build`, and the fleet-facing reusable workflows. Every path is extraction-safe.
- [sync-repos.yml](.github/workflows/sync-repos.yml) copies the published build's files into each managed repo on a dispatch, a merge directive, or the weekly cron, then pushes a branch and PR into it with the fleet PAT ([docs/sync.md](docs/sync.md)). A report that holds nothing arms squash auto-merge and lands once the repo's `all-green` check passes; anything a human should see (replaced local edits, a held retirement, a refused mirror, a registration note) stays for review.

Fleet settings are rendered into every managed repo: the sync writes a managed `.github/settings.yml` as a six-layer merge of plain YAML documents - fleet baseline, fleet visibility overlay, the selected modules' layers and their visibility overlays, the repo's own `.github/settings.local.yml` (a starter written once, for its identity keys and its own labels), then a fleet override layer no repo can weaken - and [settings-repos.yml](.github/workflows/settings-repos.yml) applies every rendered file in one github-settings-as-code run ([docs/settings.md](docs/settings.md)).

Which files the platform owns, and how strongly, is declared as data in `files.yml`, and every sync stamps the resulting map into the repo as `.github/repo-platform-manifest.json`, so a repo always carries the classification of its own files.

## Design

The measure of the design is the cost of a simple change, not the number of checks. Each principle is named by the cost it removes.

| Principle | What it means here |
|---|---|
| Behavior never lives in a written file | ci.yml is byte-identical in every repo; fleet-ci's `plan` job reads the registration at run time and every leg keys on its outputs. Adding a leg is one static job in the skeleton plus its platform workflow. |
| Fewer derived artifacts beats a better generator | What the fleet receives is written once under `files/` and copied whole; the one rendered file is each repo's `.github/settings.yml`, folded by the sync from the settings layers and the repo's overlay. The generators that remain (gitignore blocks, toolchain pin dotfiles, the theme CSS, the files table, this repo's own settings document) each have one offline drift check. |
| One run, one order | Everything after the gate is a job in the same run, ordered by `needs`: publish the build, sync the fleet, deploy the docs. No dispatch tokens between workflows. |
| Sync is copy, not merge | Managed files are replaced whole, split files have their managed region replaced around the repository's own sides, starters are written once, retired files are deleted. A rename is one line in `files.yml`. |
| Private is private by where it runs and by what the run can emit | Job names carry row indexes, names are masked where they enter a step, per-row logs go to files, and the details land in the target repository ([docs/sync.md](docs/sync.md#private-repositories)). |
| Own as few files as possible | Community health files come from the account's `.github` defaults repository; tool configs ride inside the actions that run them; the rest is the file list. |
| TypeScript only | A workflow step is one `bun` call; the shell that stays is listed in [AGENTS.md](AGENTS.md). |

## Modules

Modules (pick any combination): `bun`, `deno`, `uv`, `rust`, `site`, `release-please`, `skills`, `pr-title`, `fuzzer`, `nightly`, `custom-license`. Module selection lives in each repo's own `.repo-platform.yml`: edit its `modules:` list and the next sync applies the change. The roster is the `modules` section of [files.yml](files.yml).

## Onboarding a repo

Walkthrough: [docs/new-repo.md](docs/new-repo.md). The shape of it: scaffold with the native tool (`uv init`, `bun init`), commit a `.repo-platform.yml`, grant the fleet PAT access to the repo, and dispatch a sync that opens the first PR.

The fleet PAT's grant decides the fleet: every owned, non-archived repo the REPO_PLATFORM_TOKEN can push to is a member, and nothing in this repository lists them. A member is synced only once it carries `.repo-platform.yml`, so granting the PAT and committing that file is what enrolls a repo; revoking the grant is what removes it.

## Shipping a change

Merge to `main`; once CI's `all-green` gate passes, the `build` branch is rebuilt and the fleet picks it up on the next weekly sync. To sync right after the merge, put a directive line first in the PR body:

| Line | Syncs |
| --- | --- |
| `[fleet-sync: public]` | the public repos (the default) |
| `[fleet-sync: private]` | the private repos |
| `[fleet-sync: public, Vivswan/a]` | public repos plus the slugs listed |
| `[fleet-sync: all] <why every repo needs this now>` | the whole fleet; the justification is required and the line is written bare |

Post-green reads the directive from the merged PR's title and body ([docs/all-green.md](docs/all-green.md) has the exact grammar). A bare `[fleet-sync` anywhere else in the body, even inside a fenced example, turns the read-directives leg red and nothing syncs.

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
- The filter is dispatch-only: a `[fleet-sync: ...]` directive carrying it turns the read-directives leg red, since the leg unions the entries of every commit in its range and an intersecting token would misread there.

## Credentials

One fine-grained PAT covers the whole fleet, stored ONLY in this repo as the `REPO_PLATFORM_TOKEN` Actions secret ([create it with the permissions pre-selected](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=repo-platform+fleet%3A+push+sync+and+central+settings&contents=write&pull_requests=write&workflows=write&administration=write&issues=write)), granted access to the managed repositories. Store it with `gh secret set REPO_PLATFORM_TOKEN`.

Contents, Pull requests, Workflows, Administration, and Issues write are all hard requirements: without them sync legs or settings runs fail loudly, because a section the token cannot reach must not hide drift behind a green run. In particular a push GitHub refuses for a `.github/workflows/` change (the token lacks Workflows write) fails the sync for that repo with GitHub's error; nothing is delivered partially. A missing secret is a misconfiguration of this repo, and the failure carries the setup link.

Managed repos need no secret. One optional feature carries its own token: a `bun` repo that registers the token as a *Dependabot* secret so the lockfile fixer's push re-runs CI. Missing that token warns and degrades the feature rather than failing the run.

## Going deeper

- Guides: [new repo](docs/new-repo.md), [sync](docs/sync.md), [settings](docs/settings.md), [all-green convention](docs/all-green.md), [build provenance](docs/build-provenance.md), [site module](docs/site.md), [fuzzer module](docs/fuzzer.md), [nightly module](docs/nightly.md), [skills module](docs/skills.md), [toolchain pins](docs/toolchains.md), [eject](docs/eject.md).
- The file list and its grammar: [files.yml](files.yml) and [docs/sync.md](docs/sync.md#filesyml); the writer's code under [.github/scripts/sync/writer](.github/scripts/sync/writer).
- Working in this repo - generators, editing rules, local gates: [AGENTS.md](AGENTS.md).
- [`skills/`](skills/): portable agent skills for driving the platform from other repos - new project, sync-PR handling, module add/remove - installed with `npx skills`; never synced to managed repos.
