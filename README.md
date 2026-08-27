# repo-platform

Push-based standards management for [@Vivswan](https://github.com/Vivswan)'s repositories: a [Copier](https://copier.readthedocs.io/) template plus reusable GitHub Actions workflows and composite actions.

Everything originates here. This repo pushes standards files into managed repos as PRs and applies their repository settings centrally; managed repos carry no sync workflow and no sync secret. The code is the source of truth for how any of it behaves, so this README stays at map level and points at the rest.

## Mental model

Sources on `main`, a generated build branch, sync PRs into each repo:

- `templates/` holds the sources: `base/` plus one folder per module. Shared files take module contributions at `{# compose:<anchor> #}` anchors, spliced from per-module `fragments/` or generated from the `module.yml` manifests.
- Every green `main` commit rebuilds the orphan `template` branch, which is the composed tree copier actually renders. `main` itself is not copier-consumable.
- [sync-repos.yml](.github/workflows/sync-repos.yml) runs `copier update` against each managed repo on a weekly cron or a dispatch, then pushes a branch and PR into it with the fleet PAT. Clean updates arm squash auto-merge and land on their own once the repo's `all-green` check passes; anything a human should see (auto-resolved conflicts, withheld workflow files, failed validation, recovery runs) stays for review.

Repository settings are not part of that render, and a repo opts into them by selecting the settings-sync module in its own `.repo-platform.yml` - a repo that does not select it keeps its settings entirely to itself. For those that do, [settings-repos.yml](.github/workflows/settings-repos.yml) computes each repo's settings at apply time as a six-layer merge of plain YAML documents - fleet baseline, fleet visibility overlay, the selected modules' layers and their visibility overlays, the repo's own `.github/settings.yml`, then a fleet override layer no repo can weaken - and applies the result ([docs/settings.md](docs/settings.md)).

Which files the template owns, and how strongly, is declared as data rather than described in prose: `templates/base/ownership.yml` and each manifest's `ownership:` block. Every render stamps the resulting map into the repo as `.github/repo-platform-manifest.json`, so a repo always carries the classification of its own files.

## Modules<!-- BEGIN GENERATED: module-roster (scripts/generate.ts - edit module.yml manifests, not this block) -->

- Modules (pick any combination): `agents`, `bun`, `node`, `deno`, `uv`, `rust`, `pages`, `release-please`, `issue-templates`, `skills`, `pr-title`, `auto-assign`, `fuzzer`, `nightly`, `settings-sync`, `custom-license`. Modules with parameters (like `pages`) ask follow-up questions only when selected. After generation, module selection lives in each repo's own `.repo-platform.yml`: edit its `modules:` list and the next sync applies the change.<!-- END GENERATED: module-roster -->

## Onboarding a repo

Walkthrough: [docs/new-repo.md](docs/new-repo.md). The shape of it: scaffold with the native tool (`uv init`, `bun init`), render the template from the build branch (`copier copy gh:Vivswan/repo-platform . --vcs-ref template --trust`), commit, and grant the fleet PAT access to the repo.

`repos.yml` decides the fleet: a quoted `"*"` wildcard auto-discovers every owned, non-archived repo the PAT can write to, and `exclude:` opts repos out. A discovered repo is synced only once it carries `.repo-platform.yml`, so granting the PAT and committing that file is what enrolls a repo.

## Shipping a template change

Merge to `main`; once CI's `all-green` gate passes, the `template` branch is rebuilt and the fleet picks it up on the next weekly sync. For one repo immediately: `gh workflow run sync-repos.yml -f repo=Vivswan/<repo>`. For the whole fleet: `gh workflow run sync-repos.yml`.

## Credentials

One fine-grained PAT covers the whole fleet, stored ONLY in this repo as the `REPO_PLATFORM_TOKEN` Actions secret ([create it with the permissions pre-selected](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=repo-platform+fleet%3A+push+sync+and+central+settings&contents=write&pull_requests=write&workflows=write&administration=write&issues=write)), granted access to the managed repositories. Store it with `gh secret set REPO_PLATFORM_TOKEN`.

Contents, Pull requests, Administration, and Issues write are hard requirements: without them sync legs or settings runs fail loudly, because a section the token cannot reach must not hide drift behind a green run. Workflows write is the one scope the machinery adapts to - drop it and changes to `.github/workflows/` are withheld from the sync PR and listed in its body, while everything else still lands. A missing secret is a misconfiguration of this repo, and the failure carries the setup link.

Managed repos need no secret. Two optional features carry their own token: a `settings-sync` repo that wants push-time self-apply, and a `bun` repo that registers the token as a *Dependabot* secret so the lockfile fixer's push re-runs CI. Missing that token warns and degrades the feature rather than failing the run.

## Going deeper

- Guides: [new repo](docs/new-repo.md), [settings](docs/settings.md), [all-green convention](docs/all-green.md), [pages module](docs/pages.md), [fuzzer module](docs/fuzzer.md), [nightly module](docs/nightly.md), [skills module](docs/skills.md), [toolchain pins](docs/toolchains.md), [golden renders](docs/golden-renders.md), [private repos](docs/private-repos.md), [eject](docs/eject.md).
- Composition and ownership: the header comment in [scripts/compose_template.ts](scripts/compose_template.ts), the `templates/<module>/module.yml` manifests (editor schema: `templates/module.schema.json`), and `templates/base/ownership.yml`.
- Working in this repo - generators, editing rules, local gates: [AGENTS.md](AGENTS.md).
- [`skills/`](skills/): portable agent skills for driving the platform from other repos - new project, sync-PR handling and sync recovery, module add/remove - installed with `npx skills`; never synced to managed repos.
