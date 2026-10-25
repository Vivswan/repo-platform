---
order: 10
group: Start here
---

# Creating a new repository

The platform is standards-only: the native toolchain owns the project skeleton, and the platform layers CI conventions, settings, gitignore, and agent instructions on top. There is nothing to configure in the new repo itself - no sync workflow, no secrets. Once the repo exists on GitHub with `.repo-platform.yml` on its default branch, the push sync picks it up.

## 1. Scaffold with the native tool

```bash
# Python
uv init my-project && cd my-project

# TypeScript
mkdir my-project && cd my-project && bun init
```

## 2. Register the repository

Registration is one file, `.repo-platform.yml`, committed on the default branch ([the registration skill](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-new-project/references/registration.md) has every key):

```yaml
modules: [bun, release-please, pr-title]
project:
  name: My Project
  slug: my-project
  description: One sentence GitHub shows as the repository description
```

```bash
git init -b main
git add --all
git commit -m "chore: initialize"
```

- **`modules`** is any combination of `bun`, `uv`, `rust`, `site`, `release-please`, `pr-title`, `fuzzer`, `nightly`, and `custom-license` (the `modules` section of [files.yml](../files.yml) is the roster).
- **Module parameters** (`site.*`, `labels.*`) are read from the same file; [the registration reference](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-new-project/references/registration.md#keys) has each key and its default.
- **Nothing else is asked:** the owner is the repository's, visibility is read from GitHub, and the copyright holder defaults to the owner.

The files themselves arrive as the first sync PR ([step 4](#4-publish-and-grant-the-fleet-pat)): the writer copies them from the main commit the `stable` tag names, re-verified as green main history before any row consumes it ([build provenance](platform/build-provenance.md#provenance-is-the-commit-itself)).

**The list of platform files** is [files.yml](../files.yml) at the commit the `stable` tag names; [platform/sync/files.md](platform/sync/files.md#filesyml-reference) explains each entry's `class` and `when`. Four files matter later:

- **`.repo-platform.yml`** is the module selection's home, and its presence is what marks the repo as managed. Edit its `modules:` list in a PR, and the branch sync writes the module's files onto that PR ([changing the module selection](#changing-the-module-selection)). Repo-owned: the sync reads it and never rewrites it.
- **`.github/settings.local.yml`** is your settings overlay: identity keys, your own labels and rulesets. A starter, written once: every sync renders the managed `.github/settings.yml` from it and the fleet layers, and repo-platform's central run applies the rendered file ([settings](#5-settings-management)). Edit the overlay, never the rendered file.
- **`.gitignore`** is split: the platform owns the managed region (below), and repository-owned patterns go above the BEGIN marker or below the END marker ([split files](platform/sync/writer.md#classes)).
- **`.github/repo-platform-manifest.json`** is the ownership manifest, written by every sync: each platform-written path's class (`managed`, `split`, `starter`, or `mirror`) plus sha256 hashes of the managed content (a symlink mirror's hash covers its link target string). The `validate-managed-files` check blocks on any byte that differs from what the recorded commit's sync writes ([the managed files check](#the-managed-files-check)).

The managed region of `.gitignore` carries:

- **OS and editors:** Windows, macOS, Linux, VS Code, JetBrains.
- **The selected modules' sections:** the toolchains' github/gitignore templates, the fuzzer's `/.fuzz-failures/`.
- **Agent local state.**
- **Secrets files:** dotenv files anywhere in the tree (`.env.example` excepted), and private key material.
- **Scratch:** `*.tmp` files.
- **CI workspace paths:** every path a fleet action or workflow writes inside the checked-out workspace.

### Mirror copies of platform files

A repository that must carry byte-identical copies of a platform-written file at paths the platform does not own (the skills repository's per-folder `LICENSE.md`) declares them under `mirrors` in `.repo-platform.yml`, and every sync rewrites them in the same PR. The grammar, what the `plan` step refuses on the PR, and each outcome at sync time are [platform/sync/mirrors.md](platform/sync/mirrors.md).

## 3. Add checks to checks.yml

CI is split so the platform can keep improving its half while each repo keeps its own checks:

| File | Owner | Contents |
|---|---|---|
| `.github/workflows/ci.yml` | managed - sync updates it, don't edit; one byte-identical file for the whole fleet | a `checks` job calling checks.yml, a `platform` job calling repo-platform's [fleet.yml](../.github/workflows/fleet.yml)`@stable` (which reads the module selection from `.repo-platform.yml`), the `all-green` gate, and the static legs after it ([all-green.md](all-green.md#after-the-gate)) |
| `.github/workflows/checks.yml` | repo-owned (a starter, written once) | the repository's own test and lint jobs (multiple jobs, matrices, and further local reusable workflows all work); they run inside the gate through the `checks` job |
| `.github/workflows/post-green.yml` | repo-owned (a starter, written once) | the repository's own green-gated work, seeded as a no-op ([its contract](all-green.md#the-post-green-hook-in-every-managed-repository)) |
| `.github/workflows/release-gate.yml` | repo-owned (a starter, written once) | the release acceptance tier: called inside the gate on the release PR and on a dispatch, and by the nightly starter on the schedule; seeded as a no-op ([its contract](all-green.md#the-release-gate-hook-in-every-managed-repository)) |
| `.github/workflows/update-release.yml`, `update-release-pr.yml` | repo-owned (a starter, written once) | the release hooks ci.yml's release legs call; seeded as no-ops in every repository, module or not ([the release pipeline](#the-release-pipeline-release-please)) |
| `.github/actions/site-build/action.yml` | repo-owned (a starter, written once) | the site-build hook the `site` leg runs from the checkout before the fleet deploys: the repository's own website build goes there; seeded as a no-op in every repository, module or not ([site.md](modules/site.md#the-hook-githubactionssite-buildactionyml)) |

**A starter is written once** and never touched by a sync after that, so when the platform INTRODUCES a starter at a path a repository already owns a file at, the writer leaves the repository's file alone and reports the row `unchanged`. Check the kept file against the interface its callers expect (the [sync-PR skill](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md) has the triage row).

**The `platform` job's checks** are listed in [what gates what](all-green.md#what-gates-what), each with where it runs, and [the all-green convention](all-green.md) says how the required `all-green` check judges the gating jobs.

### The managed files check

The `validate-managed-files` step judges the repository byte to byte against what repo-platform writes at the commit its manifest records, in one sticky PR comment plus the step summary. Its verdicts and hygiene checks are [platform/sync/manifest.md](platform/sync/manifest.md#judged-at-the-synced-commit); why a registration change on a PR is red until the branch sync is [changing the module selection](#changing-the-module-selection).

### Changing the module selection

Adding a module is one dispatch of the operator with `add_modules`, and the sync PR it opens waits for review ([platform/sync/operator.md](platform/sync/operator.md#adding-modules)). Any other change, a module dropped or several edits at once, is a PR of your own that the branch sync completes ([syncing a branch](platform/sync/operator.md#syncing-a-branch)); CI itself needs nothing written, since ci.yml is the same file for every selection.

### What each module adds

What each module writes, its registration keys, and its companion steps are the add-module skill's ([what each module writes](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-add-module/SKILL.md#what-each-module-writes), [the per-module reference](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-add-module/references/modules.md)); the bun toolchain's Dependabot notes are [toolchains.md](toolchains.md#the-pins).

- **Two base files' triggers:** label a PR `fix-lint` and the repo-owned `auto-format.yml` pushes a formatting commit ([re-triggering CI](#fix-commits-and-re-triggering-ci) applies); the managed `auto-assign.yml` assigns issues and PRs to the repository owner.
- **The community health files** (contributing guide, security policy, code of conduct, issue forms) are not written: GitHub serves them from the account's `<owner>/.github` repository. A repository's own file wins over the default, and the issue forms count as one set, so any file under its own .github/ISSUE_TEMPLATE folder replaces all of the default forms.

### Fix commits and re-triggering CI

The `auto-format.yml` starter pushes its formatting commit to the PR branch with the default token (`github.token` / `GITHUB_TOKEN`).

- **The held run:** GitHub creates the new head's `pull_request` run for such a push but holds it in an approval-required state ([its GITHUB_TOKEN docs](https://docs.github.com/en/actions/concepts/security/github_token)). The required `all-green` check sits unreported until someone approves the run from the PR's merge box or the Actions tab, or pushes a commit to the branch.

- **The notice:** the job posts one sticky PR comment (edited in place on later runs) and a run warning saying so.

A PAT with Contents:RW would start the run outright, but any same-repo PR's formatter tooling runs next to that token, so the starter deliberately does not wire one in.

### The release pipeline (release-please)

[The static legs](all-green.md#the-static-legs) own the managed ci.yml's `release` leg: the workflow it calls, its needs, where it is armed, who cuts, and the known limits around the cut.

GitHub releases are immutable once published, so every release moves through three stages in one workflow run (no PAT needed to chain them), always draft-first:

1. release-please cuts the release as a draft with its tag already forced.

2. ci.yml's `update-release` job calls the repo-owned `update-release.yml` hook with the tag: packaging, asset uploads, and note edits go there, and publishing waits for every job in it.

3. ci.yml's `publish-release` job calls [fleet-release-publish.yml](../.github/workflows/fleet-release-publish.yml)`@stable`, which attests build provenance for every asset on the draft and flips it live. [actions/release-assets](../actions/release-assets/action.yml) inspects the draft first, deleting a bundle a prior attempt left.

**The attestation** is a single `attestation.json` attached to the release, verifiable per asset with `gh attestation verify <asset> -R <owner>/<repo> --bundle attestation.json`. It is skipped for releases with no assets and for non-public repositories, which need Enterprise Cloud for attestations.

Around the cut itself:

- **The release PR is `GITHUB_TOKEN`'s:** GitHub lets a workflow open one only where the repository allows Actions to create and approve pull requests. The module's settings layer ([files/release-please/settings.yml](../files/release-please/settings.yml)) grants it, and the central apply sets it once the rendered settings land. Until then the release job is red with `GitHub Actions is not permitted to create or approve pull requests`.

- **The release-PR hook:** a run in which release-please creates or refreshes the release PR (a run finding no unreleased releasable commits triggers neither) calls the repo-owned `update-release-pr.yml` hook with the PR's number and head branch. Regenerating files that must ride in the release commit and updating version references go there. Its pushes with the default `GITHUB_TOKEN` give the PR a new run held for approval, like every release-PR head ([all-green.md](all-green.md#what-gates-what)).

- **A workflow-file change between merge and cut:** `github.token` cannot tag an older commit once a later commit changed a workflow file on main (that ref creation needs `workflows: write`, which it never holds). So a workflow-file change landing on main between the release merge and its cut turns the `release` job red.

- **Both hooks are seeded in every repository,** module or not, because GitHub resolves a called `./` workflow at run creation, even when its job skips; without the module they are never called.

- **The configuration starters:** `release-please-config.json` and `.release-please-manifest.json` are repo-owned too (release-please updates the manifest via release PRs).

- **Forcing a version:** merge an empty commit with a footer: `git commit --allow-empty -m "chore: release 5.0.0" -m "Release-As: 5.0.0"`. release-please honours it once and leaves nothing behind.

- **Never set `release-as` in release-please-config.json:** the key survives the release it pinned, so the next release PR proposes the same version again, and with `force-tag-creation` it would move the published tag. The fleet's validate-managed-files check rejects the key.

## 4. Publish and grant the fleet PAT

```bash
gh repo create <owner>/my-project --public --source . --push
```

That is the whole repo-side setup, plus one grant: give the fleet PAT access to the new repository (its repository access list). The PAT's grant is the only fleet-membership fact, so that access IS the enrollment.

`.repo-platform.yml` opts it into push sync, and update PRs start arriving on the weekly cron (`gh workflow run sync-repos.yml -f repo=<owner>/my-project -R Vivswan/repo-platform` syncs it immediately).

A new managed repo touches nothing in repo-platform: there is no fleet list to edit.

## 5. Settings management

Repository settings are applied from repo-platform for every managed repository: the first sync writes your overlay `.github/settings.local.yml` once and renders the managed `.github/settings.yml` from it and the fleet layers on every sync; you edit the overlay, never the rendered file, and nothing in the repository applies it. The layers, the merge dialect, the apply, and when it runs are [settings.md](settings.md).
