# Creating a new repository

The template is standards-only: the native toolchain owns the project skeleton, repo-platform layers CI conventions, settings, gitignore, and agent instructions on top. There is nothing to configure in the new repo itself: no sync workflow, no secrets. Once the repo exists on GitHub with `.repo-platform.yml` on its default branch, repo-platform's push sync picks it up.

## 1. Scaffold with the native tool

```bash
# Python
uv init my-project && cd my-project

# TypeScript
mkdir my-project && cd my-project && bun init
```

## 2. Apply the template

Requires [copier](https://copier.readthedocs.io) >= 9.8.0 (serialized multiselect answers) and [bun](https://bun.sh) on PATH (copier's post-render stamp hook runs a bun script; the hook is also why copier needs `--trust`). `main` holds only sources; consume the GENERATED `build` branch:

```bash
git init -b main
copier copy gh:Vivswan/repo-platform . --vcs-ref build --trust
git add --all
git commit -m "chore: initialize from repo-platform"
```

Copier asks for project name, description, a `modules`<!-- BEGIN GENERATED: module-roster (scripts/generate.ts - edit module.yml manifests, not this block) --> multiselect (any combination of `agents`, `bun`, `node`, `deno`, `uv`, `rust`, `pages`, `release-please`, `issue-templates`, `skills`, `pr-title`, `auto-assign`, `fuzzer`, `nightly`, `settings-sync`, `custom-license`), follow-up parameters for modules that have them (see [docs/pages.md](pages.md), [docs/skills.md](skills.md), [docs/fuzzer.md](fuzzer.md), and [docs/nightly.md](nightly.md)), and visibility.<!-- END GENERATED: module-roster --> Answers are recorded in `.copier-answers.yml`; never delete that file, `copier update` depends on it.

Trust assumption, stated plainly: `--trust` executes the branch tip's post-render hook on your machine, and unlike the sync pipeline (which provenance-verifies the tip against a deterministic rebuild before consuming it), this local copy runs whatever the `build` tip is at that moment. The branch is MEANT to advance only through the build-branches workflow, but a user-repo ruleset cannot restrict writers (force-pushes and deletion are blocked; plain fast-forward pushes by any write-scoped actor are not) - so pin `--vcs-ref` to a reviewed build commit sha instead of the branch name if that matters in your setting.

The chosen modules also land in `.repo-platform.yml`, and that file is the selection's home from then on: edit its `modules:` list and the next sync PR applies the change. Its presence is what marks the repo as managed.

Every render also carries `.github/repo-platform-manifest.json`, the ownership manifest: each template-landed path's class (`managed`, `split`, or `starter`) plus sha256 hashes of the managed content, stamped after each render - `validate-template`'s parity check reports drift against it without blocking merges (the next sync heals).

## 3. Add checks to checks.yml

CI is split so the template can keep improving it while each repo keeps its own checks:

- `.github/workflows/ci.yml` is template-managed: the standard jobs (`typography`, `commit-names`, `validate-template`, `actionlint`, `gitleaks`, `yamllint` - on private repositories all but `validate-template` run as a single combined `base-checks` job), module checks (`pr-title` with that module, `dependency-review` and per-language `codeql-*` jobs on public repos - CodeQL also needs a toolchain), the aggregate `all-green` gate, and a `checks` job that calls checks.yml. Sync updates it; don't edit it directly.
- `.github/workflows/checks.yml` is repo-owned (`_skip_if_exists`): put the repository's test and lint jobs there (multiple jobs, matrices, and further local reusable workflows all work). They run inside the gate through the `checks` job.
- with the release-please module: a `release` job runs on top of the gate (`needs: all-green`), calling the managed `.github/workflows/release.yml` pipeline. GitHub releases are immutable once published, so every release moves through the same three stages in one workflow run (no PAT is needed to chain them), always draft-first:
  - release-please cuts the release as a draft with its tag already forced.
  - the repo-owned `update-release.yml` hook is called with the tag: packaging, asset uploads, and note edits go there, and publishing waits for every job in it.
  - the managed publish stage attests build provenance for every asset on the draft - a single `attestation.jsonl` attached to the release, verifiable per asset with `gh attestation verify <asset> -R <owner>/<repo> --bundle attestation.jsonl` (skipped for releases with no assets and for non-public repositories, which need Enterprise Cloud for attestations) - and flips it live.
- a run in which release-please creates or refreshes the release PR (independent of any release cut; a run finding no unreleased releasable commits triggers neither) calls the repo-owned `update-release-pr.yml` hook with the PR's number and head branch: regenerating files that must ride in the release commit and updating version references in docs go there. Pushes it makes to the PR branch with the default `GITHUB_TOKEN` do not re-trigger the PR's checks; with `REPO_PLATFORM_TOKEN` they do.
- the `release-please-config.json` and `.release-please-manifest.json` starters are repo-owned too (release-please updates the manifest via release PRs).
- with any toolchain module that ships a formatter (every one except rust): a repo-owned `auto-format.yml` starter (label a PR `fix-lint` to get a formatting commit pushed to it), prefilled with each selected toolchain's formatter. The push uses `github.token`, which starts no workflows, so the required `all-green` check would sit unreported on the new head - the job posts a PR comment and a run warning saying so (close/reopen the PR to re-run its checks). Swapping in a PAT with Contents:RW makes formatting commits re-trigger CI automatically, but any same-repo PR's formatter tooling runs next to that token, so the starter deliberately does not wire one in.
- with the bun module: a managed `dependabot-bun-lockfile.yml` that regenerates `bun.lock` from scratch on Dependabot's PRs and pushes the fix to the PR branch (Dependabot's own lockfile edits can leave stale nested entries that fail `bun install --frozen-lockfile`; the regeneration also refreshes every in-range pin, so most Dependabot PRs get a fix commit). Registering `REPO_PLATFORM_TOKEN` as a *Dependabot* secret is recommended: it lets the fix commit re-run CI (a fine-grained token scoped to that one repo's Contents:RW is enough; do not put the fleet PAT in a downstream repo). Without the secret the push cannot re-trigger checks, so the job posts a PR comment and a run warning saying so; close/reopen the PR to re-run its checks, or register the token.
- with the deno module: a managed `deno-audit.yml` that runs `deno audit` weekly, on lockfile-touching PRs, and on pushes to main that change `deno.lock`, failing the run when any locked dependency (JSR or npm, transitive included) has a known advisory. Every tracked `deno.lock` is audited, nested workspace lockfiles included.
- with the agents module: a repo-owned `copilot-setup-steps.yml` starter (environment setup for the Copilot coding agent), prefilled with installs for the selected toolchains.
- with the fuzzer module: a repo-owned `nightly-fuzz.yml` starter that runs a placeholder fuzz step nightly and wires up seeded replay inputs, failure artifact upload, tracking-issue filing, and auto-close on green. Replace the placeholder with your fuzzer; see [docs/fuzzer.md](fuzzer.md) for the failure-report contract it must write.
- with the nightly module: a repo-owned `nightly.yml` starter that runs a placeholder step nightly and files (or updates) a label-deduplicated tracking issue on failure, closing it on the next green night. Move the repository's slow nightly checks into it; see [docs/nightly.md](nightly.md).

See the [all-green convention](all-green.md) for how the gate works.

## 4. Publish and register

```bash
gh repo create Vivswan/my-project --public --source . --push
```

That is the whole repo-side setup, plus one grant: give the fleet PAT access to the new repository (its repository access list) - discovery only enrolls repos the token can write to. The `repos.yml` wildcard then picks it up, `.repo-platform.yml` opts it into push sync, and update PRs start arriving on the weekly cron (`gh workflow run sync-repos.yml -f repo=Vivswan/my-project -R Vivswan/repo-platform` syncs it immediately).

One optional registration in repo-platform:

- `exclude:` list in `repos.yml`: only for opting a discovered repo OUT of management; a new managed repo does not touch it.

## 5. Settings management (the settings-sync module)

Repository settings are applied from repo-platform (see [docs/settings.md](settings.md)), and selecting the `settings-sync` module is the whole opt-in: the nightly `settings-repos.yml` heal computes the repo's managed layers (the fleet defaults plus the label roster and rulesets its module selection requires), merges the repo's own `.github/settings.yml` over them, and finally the fleet override layer, which carries the invariants no repo may weaken.

The module renders `.github/settings.yml` ONCE as a repo-owned identity starter - `description`, `homepage`, `topics`, `private`, seeded from the copier answers - plus commented examples for local additions. Everything fleet-shaped stays out of the file: the fleet and module layers supply it, so the labels dependabot auto-creates can never fall out of sync with the roster - that means `dependencies` (color `0366d6`) and `github_actions` (`000000`) always, plus one label per toolchain the repo's dependabot.yml covers:<!-- BEGIN GENERATED: dependabot-labels (scripts/generate.ts - edit module.yml manifests, not this block) --> `javascript` (`168700`) for bun and npm, `deno` (`70ffaf`) for deno, `python:uv` (`2b67c6`) for uv, `rust` (`000000`) for cargo.<!-- END GENERATED: dependabot-labels --> Declare only the repo's OWN labels, rulesets, and overrides in settings.yml: a same-name label there replaces the fleet one wholesale, a same-name ruleset merges into it with its rules appended by type, and setting a key to `null` opts the repo out of that part of the fleet defaults - except where the override layer declares it, which no repo file can beat.

The module also renders a `settings-sync.yml` workflow for push-time self-apply (needs a repo-scoped PAT and warns and skips without one); the central heal applies the repo's settings either way. A repo without the module has unmanaged settings - nothing installs or heals the `main` ruleset (so `all-green` may not be a required check) and labels are never reconciled.
