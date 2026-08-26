# repo-platform

Push-based standards management for [@Vivswan](https://github.com/Vivswan)'s repositories: a [Copier](https://copier.readthedocs.io/) template plus reusable GitHub Actions workflows and composite actions.

Everything originates here. This repo pushes standards files into managed repos as PRs and applies their repository settings centrally; managed repos carry no sync workflow and no sync secret. The code is the source of truth for how any of it behaves, so this README stays at map level and points at the rest.

## Mental model

Sources on `main`, a generated build branch (rebuilt from the latest green `main` commit whenever CI passes), sync PRs into each repo:

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

<<<<<<< HEAD
- Guides: [new repo](docs/new-repo.md), [settings](docs/settings.md), [all-green convention](docs/all-green.md), [pages module](docs/pages.md), [fuzzer module](docs/fuzzer.md), [nightly module](docs/nightly.md), [skills module](docs/skills.md), [toolchain pins](docs/toolchains.md), [golden renders](docs/golden-renders.md), [private repos](docs/private-repos.md), [eject](docs/eject.md).
- Composition and ownership: the header comment in [scripts/compose_template.ts](scripts/compose_template.ts), the `templates/<module>/module.yml` manifests (editor schema: `templates/module.schema.json`), and `templates/base/ownership.yml`.
- Working in this repo - generators, editing rules, local gates: [AGENTS.md](AGENTS.md).
- [`skills/`](skills/): portable agent skills for driving the platform from other repos - new project, sync-PR handling and sync recovery, module add/remove - installed with `npx skills`; never synced to managed repos.
=======
## Layout

| Path | Purpose |
|---|---|
| `templates/` | SOURCE of the template: one folder per module (each with a `module.yml` manifest, the source of module identity) plus `base/`; shared files composed via `{# compose:<anchor> #}` markers filled from per-module `fragments/` or generated from manifest data |
| `copier.yml` | Questions (module choices, toolchain defaults, and the tracking-label validators are generated regions fed by the `templates/<module>/module.yml` manifests; standards-only, project skeletons come from `uv init` / `bun init`) |
| `repos.yml` | Fleet config: which repos are managed (wildcard + exclude) |
| `.github/settings-baseline.yml` | Layer 1 of the settings merge: the overridable fleet defaults. The visibility overlays and the fleet override sit beside it ([docs](docs/settings.md)) |
| `.github/workflows/sync-repos.yml` | Push sync fan-out: weekly cron + dispatch, parallel matrix legs, one per repo |
| `.github/workflows/settings-repos.yml` | Central settings apply across the fleet |
| `.github/workflows/reusable-*.yml` | Reusable workflows: template-sync (the push-sync engine), auto-assign, codeql, pages ([docs](docs/pages.md)), apply-settings ([docs](docs/settings.md)) |
| `actions/check-typography` | Blocks look-alike/invisible unicode (vendored from cloud-speech, config via `.typography-allow` + repo-owned `.typography-allow.local`) |
| `actions/dependency-review` | The fleet's dependency-review gate: one home for the upstream pin and severity threshold |
| `actions/validate-template` | Enforces markers, YAML validity, and the all-green convention |
| `actions/validate-commit-names` | Conventional Commit subjects on every push/PR commit |
| `actions/validate-skills` | Validates hosted agent skills: plugin manifests, SKILL.md contracts, `npx skills` discovery (used by the skills module, [docs](docs/skills.md)) |
| `actions/fuzz-issue` | Files/updates the label-deduplicated nightly tracking issue (fuzz failure reports or a generic nightly-failure body), closes it on green (used by the fuzzer and nightly starters, [fuzzer docs](docs/fuzzer.md), [nightly docs](docs/nightly.md)) |
| `actions/release-health` | Gates releases: open tracking-stream issues (the fuzzer and nightly modules' labels) and blocker issues and open Dependabot alerts block, an override label on the release PR bypasses with warnings |
| `scripts/build_gitignore.ts` | <!-- BEGIN GENERATED: gitignore-upstream-map (scripts/generate.ts - edit module.yml manifests, not this block) -->Regenerates the gitignore outputs (`templates/base/.gitignore.jinja`, the bun/node/deno/uv/rust toolchain fragments, this repo's `.gitignore`) from the latest [github/gitignore](https://github.com/github/gitignore) (Windows + macOS + Linux always, Node + bun / Deno / Python / Rust by bun/node/deno/uv/rust module)<!-- END GENERATED: gitignore-upstream-map --> |
| `skills/` | Portable agent skills for working with the platform from other repos (new-project setup, sync-PR handling, module add/remove); installed with `npx skills` (see each skill's README), never synced to managed repos |
| `docs/` | [all-green convention](docs/all-green.md), [new repo](docs/new-repo.md), [pages module](docs/pages.md), [fuzzer module](docs/fuzzer.md), [nightly module](docs/nightly.md), [skills module](docs/skills.md), [settings](docs/settings.md), [toolchain pins](docs/toolchains.md), [eject](docs/eject.md) |

## File ownership in managed repos

| Category | Files |
|---|---|
| Fully managed (template wins) | `.copier-answers.yml` (managed; the one sanctioned edit is changing a question's value key via PR to set a module parameter - never the underscore keys), `ci.yml`, `release.yml` (the release pipeline: cuts the draft, calls the repo-owned `update-release.yml` hook, attests every asset into a single `attestation.jsonl`, publishes), `dependabot-bun-lockfile.yml` (bun module), `deno-audit.yml` (deno module), workflow callers, `dependabot.yml`, `CODE_OF_CONDUCT.md`, `.yamllint`, `.typography-allow`, agent-file symlinks, `.github/repo-platform-manifest.json` (the ownership manifest: every template-landed path's class - managed / split / starter - with sha256 hashes of the managed content, stamped after each render; `validate-template` reports byte drift against it without gating merges) |
| Managed shape, repo-owned selection | `.repo-platform.yml`: its presence marks the repo as participating in push sync, and its `modules:` list is the repo's own module selection (edit it; the next sync applies the change) |
| Managed + local sections | `.gitignore` (LOCAL section is yours), `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE.md`, `AGENTS.md` (everything below the `<!-- repo-platform:local-section -->` line is yours; sync rebuilds these files structurally on every run - the managed half comes from a clean render, your half rides through byte-for-byte, and edits INSIDE the managed half are reset with a note in the PR body that holds the PR for review; `.gitignore` uses its own LOCAL markers rather than the sentinel, with the same rebuild semantics - the LOCAL section is carried byte-for-byte, the managed section is reset; CONTRIBUTING.md is a public-only render, so a flip to private retires that file, local section included, while SECURITY.md and LICENSE.md are visibility-independent), `.gitattributes`, `.editorconfig`, and `.github/CODEOWNERS` (each carries a `# repo-platform:local-section` marker: repository-specific entries below it are yours - and the semantics work in your favor: .editorconfig applies later sections over earlier ones and CODEOWNERS applies the LAST matching pattern, so entries below the marker override the managed half). LICENSE.md carries the fleet license, the Individual and Small Organization License - free for individuals, internal-use-only for small organizations, everyone else licenses from the licensor; local notices (third-party components; prior licensing needs no notice - git history is the record) go below its marker, and selecting the `custom-license` module carries your own license instead, still at `LICENSE.md` - the file then becomes repo-owned and sync never touches it |
| Mergeable (three-way) | `.github/settings.yml` (seeded by the settings-sync module; never deleted by sync) |
| Generated once, then repo-owned | `checks.yml` (your CI jobs, called inside the all-green gate), `update-release.yml` (your hook in the managed release pipeline: packaging, asset uploads, and note edits between the draft cut and the attested publish), `update-release-pr.yml` (your hook on release-PR refreshes: regenerated files and version references that must ride in the release commit), `auto-format.yml`, `copilot-setup-steps.yml`, `nightly-fuzz.yml` (the fuzzer module's starter, [docs](docs/fuzzer.md)), `nightly.yml` (the nightly module's starter, [docs](docs/nightly.md)), `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (the skills module's starters, [docs](docs/skills.md)), issue forms and chooser config (starters you tailor to the repo), `release-please-config.json`, `.release-please-manifest.json`, `.gitleaks.toml` (repos accumulate their own allowlists), `.github/actionlint.yaml` (same for actionlint ignores) |
| Repo-owned (never touched) | source code, release tooling, `.typography-allow.local`, everything else |

`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to the repo's `AGENTS.md` (the `agents` module, on by default): one source of truth for agent instructions.

## Shipping template changes

- Merging to `main` rebuilds the `template` branch once CI's `all-green` gate passes (the build-branches workflow triggers on the CI run completing successfully, and its publish step independently refuses any main commit without a successful CI run - the schedule and manual-dispatch paths included; the sync re-checks the shipped build's stamped source the same way); managed repos pick the new build up through the weekly sync-repos cron. For one repo immediately: `gh workflow run sync-repos.yml -f repo=Vivswan/<repo>`; for the whole fleet: `gh workflow run sync-repos.yml`.
- Managed repos that select the `release-please` module get their own release pipeline; repo-platform itself runs none - the template branch is its only release artifact.
>>>>>>> b5dce98 (feat(build)!: publish and sync only from green main commits)
