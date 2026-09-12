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

`modules` is any combination of `bun`, `deno`, `uv`, `rust`, `site`, `release-please`, `pr-title`, `fuzzer`, `nightly`, and `custom-license` (the `modules` section of [files.yml](../files.yml) is the roster); modules with parameters read them from the same file (see [docs/site.md](site.md), [docs/fuzzer.md](fuzzer.md), and [docs/nightly.md](nightly.md)). Nothing else is asked: the owner is the repository's, visibility is read from GitHub, and the copyright holder defaults to the owner.

The files themselves arrive as the first sync PR ([step 4](#4-publish-and-register)): the writer copies them from the published `build` branch, whose tip is provenance-verified against a rebuild from its stamped main commit before any row consumes it ([build provenance](build-provenance.md#the-provenance-proof)).

Four files matter later:

| File | Role |
|---|---|
| `.repo-platform.yml` | The module selection's home: edit its `modules:` list in a PR; the sync PR carrying the module's files follows the merge ([changing the module selection](#changing-the-module-selection)). Its presence is what marks the repo as managed. Repo-owned: the sync reads it and never rewrites it. |
| `.github/settings.local.yml` | Your settings overlay: identity keys, your own labels and rulesets. A starter, written once; the sync renders the managed `.github/settings.yml` from it and the fleet layers on every sync, and repo-platform's central run applies the rendered file ([settings](#5-settings-management)). Edit the overlay, never the rendered file. |
| `.gitignore` | Split: the managed region carries the OS sections, the selected modules' sections (the toolchains' github/gitignore templates, the fuzzer's `/.fuzz-failures/`), agent local state, and the CI workspace paths repo-platform's workflow steps create inside every checked-out workspace (`/results.sarif`), so a stray local file of the same name can never be committed and later collide with the CI step that creates it. Repository-owned patterns go above the BEGIN marker or below the END marker ([split files](fleet-guidelines.md#split-files-the-managed-region)). |
| `.github/repo-platform-manifest.json` | The ownership manifest: each platform-written path's class (`managed`, `split`, `starter`, `mirror`, or `link`) plus sha256 hashes of the managed content (a link's hash covers its target string), written by every sync. The `validate-managed-files` check blocks on drift against it ([the managed files check](#the-managed-files-check)): managed content changed outside a sync, or a recorded managed file missing from the repo. |

### What the sync writes

Every path below comes from `files.yml` on the build branch ([sync.md](sync.md) has the writer's contract). Class `managed` is rewritten whole on every sync, `split` rewrites only the BEGIN/END-bounded region and keeps what the repository wrote around it, `starter` is written once and repo-owned from then on, `link` is a relative symlink placed and repaired on every sync. A path listed more than once has one variant per condition.

<!-- BEGIN GENERATED: files-table (scripts/files_table.ts - edit files.yml, not this block) -->
| File | Class | When |
| --- | --- | --- |
| `.editorconfig` | split | always |
| `.gitattributes` | split | always |
| `.gitignore` | split | always |
| `.github/CODEOWNERS` | split | always |
| `.github/dependabot.yml` | managed | always |
| `.github/actionlint.yaml` | starter | always |
| `.github/instructions/review.instructions.md` | managed | always |
| `.github/settings.local.yml` | starter | public |
| `.github/settings.local.yml` | starter | private |
| `.github/settings.yml` | managed | always |
| `.github/workflows/ci.yml` | managed | always |
| `.github/workflows/checks.yml` | starter | always |
| `.github/workflows/post-green.yml` | starter | always |
| `.github/workflows/update-release.yml` | starter | always |
| `.github/workflows/update-release-pr.yml` | starter | always |
| `.github/actions/site-build/action.yml` | starter | always |
| `.github/workflows/copilot-setup-steps.yml` | starter | always |
| `.gitleaks.toml` | starter | always |
| `.yamllint` | managed | always |
| `.github/workflows/auto-assign.yml` | managed | any of `bun`, `deno`, `uv`; public |
| `.github/workflows/auto-assign.yml` | managed | private |
| `.github/workflows/auto-assign.yml` | managed | without `bun`, `deno`, `uv`; public |
| `.github/workflows/auto-format.yml` | starter | any of `bun`, `deno`, `uv` |
| `.typography-allow` | managed | without `release-please` |
| `.typography-allow` | managed | modules: `release-please` |
| `AGENTS.md` | split | without `bun`, `deno`, `uv`, `rust` |
| `AGENTS.md` | split | any of `bun`, `deno`, `uv`, `rust` |
| `LICENSE.md` | split | without `custom-license` |
| `CLAUDE.md` | link | always |
| `.github/agents.md` | link | always |
| `.github/copilot-instructions.md` | link | always |
| `.bun-version` | managed | modules: `bun` |
| `.github/workflows/dependabot-bun-lockfile.yml` | managed | modules: `bun` |
| `.dvmrc` | managed | modules: `deno` |
| `.github/workflows/deno-audit.yml` | managed | modules: `deno` |
| `.release-please-manifest.json` | starter | modules: `release-please` |
| `release-please-config.json` | starter | modules: `release-please` |
| `.github/workflows/pr-title.yml` | managed | modules: `pr-title` |
| `.github/workflows/nightly-fuzz.yml` | starter | modules: `fuzzer` |
| `.github/workflows/nightly.yml` | starter | modules: `nightly` |
<!-- END GENERATED: files-table -->

### Mirror copies of platform files

Some repos must carry byte-identical copies of a platform-written file at paths the platform does not own - the skills repo copies `LICENSE.md` into `template/` and into every skill folder, because a standalone skill install copies only that folder. Declare the copies in `.repo-platform.yml` and every sync rewrites them from the freshly written source, in the same PR:

```yaml
mirrors:
  - source: LICENSE.md
    targets:
      - template/LICENSE.md
      - skills/*/LICENSE.md
  - source: AGENTS.md
    kind: symlink
    targets:
      - docs/AGENTS.md
```

- `source` names one file `files.yml` writes for the repository as class `managed` or `split`; mirroring repo-owned content is the repository's own job.
- `kind` is how each target carries the source: `copy` (the default) writes its bytes; `symlink` places a symbolic link to it, relative to the target's directory (`docs/AGENTS.md -> ../AGENTS.md`), for a tool that follows links and must never see a stale copy. A Windows checkout needs `core.symlinks` for a link; no fleet runner is Windows today.
- A `*` in a target matches within one path segment, resolved against the repo's tree at sync time: a literal final segment is written into every matched directory even when the file does not exist there yet, so a new skill folder gets its copy with no declaration edit. `**` is rejected: nothing in the fleet needs recursive matching, and an unbounded walk over a target-controlled pattern is risk with no customer.
- The `plan` job of fleet CI rejects, on the PR that introduces it, a declaration `files.yml` alone proves unwritable, so it can never land: a source `files.yml` does not write here; a `**`; a target that is not a clean repository path, is or sits under `.repo-platform.yml` itself, sits under `.github/workflows/` (workflow files are platform-written, so a mirror there would be a second writer), or is, sits under, or is a path prefix of a path `files.yml` writes or retires (one path, one writer); a literal target declared twice or nested with another (both sides, so declaration order never chooses the winner); a pattern whose literal prefix is a literal target; a pattern that matches the registration, a path `files.yml` writes or retires (reserved by the claim, held or not), or another source's literal target (the writer would expand it to that path and refuse it there).
- The sync writes every declared target or fails the run; none is left stale behind a hold row. A directory at a target, or a file where an ancestor directory must be, is removed and the target written (`replaced`, the detail naming what stood there); other content at a target (a file where a link is declared, a link where a copy is, or a link elsewhere, included) is replaced with its diff shown (`replaced local edits`); both hold the PR for review. A symbolic link above a target (never followed), a source held this run, a pattern matching nothing or reading through a link, and a glob landing on a nested or contested path fail the sync: no PR, and the `[repo-platform] sync failed` issue names each declaration and its reason. Clean copies (`written`, `current`) are listed in the PR body but stay auto-merge-eligible: the declaration is repo-owned consent, and holding every LICENSE bump for review would defeat the auto-heal.
- Every target is recorded in the ownership manifest as class `mirror` with the copy's hash (a `symlink` target with `kind: symlink` and the hash of its link target string), so the next sync can tell its own previous write from a local edit, and `validate-managed-files` reads each target through its recorded kind: a regular file where a link is recorded, a link where a copy is, or a link pointing elsewhere is a finding. The implementation: [sync/writer/mirrors.ts](../.github/scripts/sync/writer/mirrors.ts) and, for the rules both readers share, [actions/plan/mirrors.ts](../actions/plan/mirrors.ts); [sync.md](sync.md#mirrors) has the outcome table.

## 3. Add checks to checks.yml

CI is split so the platform can keep improving its half while each repo keeps its own checks:

| File | Owner | Contents |
|---|---|---|
| `.github/workflows/ci.yml` | managed - sync updates it, don't edit; one byte-identical file for the whole fleet | a `checks` job calling checks.yml, a `ci` job calling repo-platform's [fleet-ci.yml](../.github/workflows/fleet-ci.yml)`@build` (which reads the module selection from `.repo-platform.yml`), the `all-green` gate, and the static legs after it ([all-green.md](all-green.md#after-the-gate)) |
| `.github/workflows/checks.yml` | repo-owned (a starter, written once) | the repository's own test and lint jobs (multiple jobs, matrices, and further local reusable workflows all work); they run inside the gate through the `checks` job |
| `.github/workflows/post-green.yml` | repo-owned (a starter, written once) | the repository's own green-gated work (applying settings, refreshing generated artifacts): the managed `post-green` job calls it on every push to main whose gate passed, with the judged sha, before the release leg ([after the gate](all-green.md#after-the-gate)). The caller grants `contents: write` (a fast-forward branch push) and `id-token: write` (OIDC trusted publishing), the ceiling for every hook job. Seeded as a no-op |
| `.github/workflows/update-release.yml`, `update-release-pr.yml` | repo-owned (a starter, written once) | the release hooks ci.yml's release legs call; seeded as no-ops in every repository, module or not, because GitHub resolves a called `./` workflow at run creation ([the release pipeline](#the-release-pipeline-release-please)) |
| `.github/actions/site-build/action.yml` | repo-owned (a starter, written once) | the site-build hook the `site` leg runs from the checkout before the fleet deploys: the repository's own website build goes there; seeded as a no-op in every repository, module or not ([site.md](site.md#the-hook-githubactionssite-buildactionyml)) |

A starter is written once and never touched by a sync after that, so when the platform INTRODUCES a starter at a path a repository already owns a file at (post-green.yml on its rollout), the writer leaves the repository's file alone and reports the row `unchanged`. Check the kept file against the interface its callers expect (the [sync-PR skill](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md) has the triage row).

The `ci` job runs the standard checks (typography, file-size ([the caps](fleet-guidelines.md#file-size-caps)), commit-names, actionlint, gitleaks, yamllint, as the steps of one `base-checks` job whose judge step lists every failed check), `validate-managed-files`, and the module checks (`dependency-review` and a per-language CodeQL matrix on public repos - CodeQL also needs a toolchain). The managed `all-green` job in the same ci.yml needs both callers and its own check run is the required `all-green` check - the [all-green convention](all-green.md).

### The managed files check

The `validate-managed-files` job judges the repository against the platform's current shape, in one sticky PR comment plus the step summary, run by the [validate-managed-files](../actions/validate-managed-files/action.yml) action with the build branch's `files.yml` as its vocabulary:

| Check | Blocks on |
|---|---|
| Registration | a missing or unreadable `.repo-platform.yml`, a `modules` list that is not a list, a module name `files.yml` does not know |
| Release-please config | a `release-as` key in `release-please-config.json` ([the release pipeline](#the-release-pipeline-release-please)) |
| YAML | a YAML file anywhere in the repository that does not parse |
| Conflict markers | a merge's conflict markers left in a source, config, or markdown file (the validator's text suffixes) |
| Manifest shape | a missing, unparsable, or malformed `.github/repo-platform-manifest.json`, an entry carrying a field the vocabulary lacks, or an entry keyed by a path the sync never writes (`./x`, `a//b`, `..`, a trailing slash, a backslash: none is a path the grammar allows, and the first two also alias a declared path the parity check would not recognise) |
| Manifest parity | an entry recorded under a class other than the one `files.yml` writes its path under for this repository's modules and visibility (a relabel to `starter` would switch parity off; a path no selected entry writes, a mirror target say, is judged as recorded), managed content whose hash differs from its record (an edit outside a sync), or a recorded managed file missing from the repo |

- Errors block; advisories inform. The verdict is ONE per run: clean, findings, or not judged. A validator that exits nonzero without a finding, exits zero with one, crashes before writing its report, times out, or dies on a signal is not judged, and not judged fails the check with the reason in the comment.
- The report step always runs, reads the verdict once, and exports it as the `integrity` output; a missing or malformed verdict exports failure. When no bun matching the action's pin is available the step exports the failure itself, with no verdict to read.
- The check judges what the last sync recorded against the classes the edited selection makes live, so a module edit alone changes nothing here unless it flips a recorded path's class (the exception in the table below); the sync PR that follows brings the files and the manifest together ([changing the module selection](#changing-the-module-selection)).

### Changing the module selection

A module change is two PRs in the managed repository: the registration edit, then the sync PR carrying the module's files and the manifest stamp that records them. CI itself needs nothing written: ci.yml is the same file for every selection, and fleet-ci's `plan` job reads the new list on the next run, validating the registration on the first PR.

- The managed-files check is green on the first PR by design: it judges the stamped manifest against the classes the new selection makes live, so nothing is bypassed; the one exception is an edit that flips a recorded path's class (see the table below).
- The one red to expect: a module whose fleet-ci jobs read a file the sync has not written yet (a toolchain module's jobs read its version pin, `.bun-version` for `bun`). It stays red until the sync PR lands unless the first PR adds that file.
- The module's DATA files (its workflows, starters, and toolchain pins) are what the second PR carries, written by the sync once the first has merged:

```text
PR edits modules: in .repo-platform.yml
  -> plan reads the registration and checks it against the build's module data (an unknown module or a malformed file fails the job)
  -> validate-managed-files stays green: it judges the files the manifest records, and the new module's are not recorded yet (unless the edit flips a recorded path's class: see the table)
  -> merge the registration edit (the files cannot precede it: the sync reads the default branch), then
             gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<repo> -f manual=true
  -> the sync opens a PR carrying the files and the new manifest stamp (the writer replaces platform files whole), held for review
  -> review and merge the sync PR
```

| | |
|---|---|
| What the PR check judges | The `plan` job runs on every event and reads `.repo-platform.yml`, checking it against the module data the build branch ships beside the plan action: every module name must exist and the file must parse. It fails closed, so an unknown module or a malformed registration never merges through a PR (a registration the sync does meet with an unknown name has that name dropped and the sync PR held with a Registration note). |
| What the PR check does not judge | `validate-managed-files` reads the edited registration for its module names and for the class each recorded path now falls under, but its parity check walks the manifest the LAST sync recorded, so the new module's missing files are not findings. Nothing on the PR compares the tree against the new selection; the sync PR brings the files, and the manifest with them. One edit does fail the PR: a selection that flips a recorded path's class (dropping `custom-license` while a mirror still targets `LICENSE.md`, say), because the sync that restamps the record reads the default branch. Stage it: drop the mirror declaration first, let a sync drop its record, then change the modules. |
| Enforced by | [actions/plan](../actions/plan/action.yml), called by fleet-ci.yml's `plan` job. The sync side is a manual run of sync-repos.yml ([the manual run](#the-manual-run)). |

#### The manual run

`gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f manual=true` runs the ordinary sync against the repository's default branch and delivers the files as a sync PR that waits for review:

- Same code path as a scheduled sync ([sync.md](sync.md#the-operator)): the writer selects by the registration on the default branch and replaces platform files whole; `manual=true` only keeps auto-merge off, so a clean report waits for a human too.
- A broken target is re-synced the same way: re-run the workflow, and the writer replaces platform files whole. There is no recovery mode.
- A failed run surfaces where every sync failure does: from the target checkout on, one `[repo-platform] sync failed` issue in the target repository carrying the log tails ([private repositories](sync.md#private-repositories)); a failure before the target is resolved (the plan job, or a row's setup) is red in the run itself, and re-running the workflow is the remedy ([sync.md](sync.md#the-operator)).

### What each module adds

The community health files (contributing guide, security policy, code of conduct, issue forms) are not written: GitHub serves them to every repository under the account from the account's `<owner>/.github` repository. A repository that needs a different text commits its own file, which GitHub prefers over the default; the issue forms count as one set, so any file under a repository's own `.github/ISSUE_TEMPLATE/` replaces all of the default forms. A fragment left behind when a sync PR retires one of them hides the default the same way, so that PR's review deletes or completes it before merging ([the sync-pr skill](../skills/repo-platform-sync-pr/SKILL.md#repository-owned-markdown-after-a-retirement)).

Every repository receives the agent instructions (`AGENTS.md` with its `CLAUDE.md`, `.github/agents.md`, and `.github/copilot-instructions.md` symlinks), a repo-owned `copilot-setup-steps.yml` starter prefilled with installs for the selected toolchains, a managed `.github/instructions/review.instructions.md` telling Copilot code review how to word its comments (problem first, then an example, then the fix; short plain sentences) and what earns one (a demonstrable defect in the diff; no speculative hardening, no unenforced style opinions), the managed `auto-assign.yml` (issues, PRs, and code scanning alerts assigned to the owner), the settings overlay starter and the rendered `.github/settings.yml` described below. The modules add:

| Module | What lands |
| --- | --- |
| pr-title | A managed `pr-title.yml` workflow checking the PR title is a Conventional Commit with at most one scope, the grammar the `commit-names` job holds squash subjects to (titles become squash-commit subjects), with its own `pr-title` required check installed by the module's settings layer ([the pr-title ruleset](settings.md#the-pr-title-ruleset)). |
| release-please | Arms the managed ci.yml's static `release` legs and lands the repo-owned release-please configuration - [the release pipeline](#the-release-pipeline-release-please) below. |
| bun | A managed `dependabot-bun-lockfile.yml` that calls repo-platform's `dedupe-bun-lockfile` action at `@build` to regenerate `bun.lock` from scratch on Dependabot's PRs and push the fix to the PR branch (Dependabot's own lockfile edits can leave stale nested entries that fail `bun install --frozen-lockfile`; the regeneration also refreshes every in-range pin, so most Dependabot PRs get a fix commit). [Re-triggering CI](#fix-commits-and-re-triggering-ci) applies. |
| deno | A managed `deno-audit.yml` that runs `deno audit` weekly, on lockfile-touching PRs, and on pushes to main that change `deno.lock`, failing when any locked dependency (JSR or npm, transitive included) has a high or critical advisory. Every tracked `deno.lock` is audited, nested workspace lockfiles included; a repository with no tracked `deno.lock` fails the run. |
| any toolchain with a formatter (every one except rust) | A repo-owned `auto-format.yml` starter: label a PR `fix-lint` to get a formatting commit pushed to it, prefilled with each selected toolchain's formatter. Width limits apply to code only: the deno step runs `deno fmt --prose-wrap preserve`, so markdown prose keeps its line breaks. [Re-triggering CI](#fix-commits-and-re-triggering-ci) applies. |
| fuzzer | A repo-owned `nightly-fuzz.yml` starter - placeholder fuzz step, seeded replay inputs, failure artifact upload, [tracking-issue](tracking-issues.md) filing, auto-close on green. Replace the placeholder with your fuzzer; [fuzzer.md](fuzzer.md) has the contract. |
| nightly | A repo-owned `nightly.yml` starter for checks too slow for every PR - placeholder step, tracking issue on failure, auto-close on the next green night ([nightly.md](nightly.md)). |

### Fix commits and re-triggering CI

Two of those workflows push fix commits to PR branches, and a push made with the default token (`github.token` / `GITHUB_TOKEN`) starts no workflows - the required `all-green` check would sit unreported on the new head. Both jobs post one sticky PR comment (edited in place on later runs) and a run warning naming the way out.

- auto-format: the new head's `pull_request` run sits at "awaiting approval". Open it in the Actions tab and choose "Approve and run", or push an empty commit. A PAT with Contents:RW would re-trigger them, but any same-repo PR's formatter tooling runs next to that token, so the starter deliberately does not wire one in.
- bun lockfile fixes, unblocking the PR it pushed to: the new head's `pull_request` run sits at "awaiting approval". Open it in the Actions tab and choose "Approve and run", or push an empty commit. On a public repository, whose ruleset carries the code-scanning rule, a hand `workflow_dispatch` run does not unblock the merge: it wants the PR-event CodeQL analysis.
- Known limitation, accepted: Dependabot's bun runner reads `bun.lock` lockfileVersion 1 only, while bun 1.4 writes version 2. A Dependabot bun PR that cannot be rebased is closed and the bump made by hand.

### The release pipeline (release-please)

The `release` leg in the managed ci.yml - needing the gate and the repo-owned post-green hook, released only by a green gate and a green hook on a push to main with the judged commit passed through, and armed only where `.repo-platform.yml` selects the module ([all-green.md](all-green.md#after-the-gate)) - calls repo-platform's [fleet-release.yml](../.github/workflows/fleet-release.yml)`@build`. GitHub releases are immutable once published, so every release moves through three stages in one workflow run (no PAT needed to chain them), always draft-first:

1. release-please cuts the release as a draft with its tag already forced.
2. ci.yml's `update-release` job calls the repo-owned `update-release.yml` hook with the tag: packaging, asset uploads, and note edits go there, and publishing waits for every job in it.
3. ci.yml's `publish-release` job calls [fleet-release-publish.yml](../.github/workflows/fleet-release-publish.yml)`@build`, which attests build provenance for every asset on the draft - a single `attestation.json` attached to the release, verifiable per asset with `gh attestation verify <asset> -R <owner>/<repo> --bundle attestation.json` (skipped for releases with no assets and for non-public repositories, which need Enterprise Cloud for attestations) - and flips it live.

Around the cut itself:

- A run in which release-please creates or refreshes the release PR (a run finding no unreleased releasable commits triggers neither) calls the repo-owned `update-release-pr.yml` hook with the PR's number and head branch: regenerating files that must ride in the release commit and updating version references go there. Its pushes with the default `GITHUB_TOKEN` do not re-trigger the PR's checks.
- The release is cut by the run on the release commit, in its own job lane keyed by that commit, so no later merge can cancel or take over the cut; the run of any other push only proposes or refreshes the release PR, and skips even that once main has moved on ([all-green.md](all-green.md#after-the-gate)). Two release PRs merged before either is cut are both tagged by the first cut run. When a release merge and an ordinary push land within one run's span, the ordinary run's release-PR refresh can abort green while the merged release PR still wears `autorelease: pending`; the first push after the cut has relabelled it tagged refreshes the PR again.
- `github.token` cannot tag an older commit once a later commit changed a workflow file on main (that ref creation needs `workflows: write`, which it never holds), so a workflow-file change landing on main between the release merge and its cut turns the `release` job red.
- Both hooks are seeded in every repository, module or not (a called `./` workflow must exist at run creation even when its job skips); without the module they are never called.
- The `release-please-config.json` and `.release-please-manifest.json` starters are repo-owned too (release-please updates the manifest via release PRs).
- To force a specific version, merge an empty commit with a footer: `git commit --allow-empty -m "chore: release 5.0.0" -m "Release-As: 5.0.0"`. release-please honours it once and leaves nothing behind. Never set `release-as` in release-please-config.json: the key survives the release it pinned, so the next release PR proposes the same version again, and with `force-tag-creation` it would move the published tag. The fleet's validate-managed-files check rejects the key.

## 4. Publish and register

```bash
gh repo create <owner>/my-project --public --source . --push
```

That is the whole repo-side setup, plus one grant: give the fleet PAT access to the new repository (its repository access list) - the PAT's grant is the only fleet-membership fact, so that access IS the enrollment. `.repo-platform.yml` opts it into push sync, and update PRs start arriving on the weekly cron (`gh workflow run sync-repos.yml -f repo=<owner>/my-project -R Vivswan/repo-platform` syncs it immediately).

A new managed repo touches nothing in repo-platform: there is no fleet list to edit.

## 5. Settings management

Repository settings are applied from repo-platform for every managed repository - the full model (six layers, merge dialect, apply semantics) is in [settings.md](settings.md). What the new repo sees:

- The first sync writes `.github/settings.local.yml` ONCE as a repo-owned overlay (`description` from the registration's `project.description`, `homepage` and `topics` declared empty, `private` matching the repository's visibility) plus commented examples, and right after it the managed `.github/settings.yml`: the fleet layers, the selected modules' layers, and that overlay folded into one document. The rendered file is rewritten on every sync; the overlay never is.
- Declare only the repo's OWN labels, rulesets, and overrides in `.github/settings.local.yml`; [the merge dialect](settings.md#the-merge-dialect) says how they combine with the fleet layers, and the override layer's invariants win regardless. Everything fleet-shaped stays out of the overlay, so the labels dependabot auto-creates can never fall out of sync with the roster: `dependencies` (color `0366d6`) and `github_actions` (`000000`) always, plus one label per toolchain the repo's dependabot.yml covers: `javascript` (`168700`) for bun, `deno` (`70ffaf`) for deno, `python:uv` (`2b67c6`) for uv, `rust` (`000000`) for cargo.
- An overlay edit is two PRs: yours, then the sync PR that re-renders `.github/settings.yml` ([the manual run](#the-manual-run) brings it at once). Never edit the rendered file: the next sync replaces it and holds its PR, and the [managed files check](#the-managed-files-check) reds the PR that edits it.
- Nothing in the repository applies its settings: repo-platform's central run applies the rendered file after every green main merge there and nightly, once the sync PR carrying it has merged ([settings.md](settings.md#how-the-apply-works)).
