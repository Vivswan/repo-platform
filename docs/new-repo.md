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

- **`modules`** is any combination of `bun`, `deno`, `uv`, `rust`, `site`, `release-please`, `pr-title`, `fuzzer`, `nightly`, and `custom-license` (the `modules` section of [files.yml](../files.yml) is the roster).
- **Module parameters** are read from the same file (see [docs/modules/site.md](modules/site.md), [docs/modules/fuzzer.md](modules/fuzzer.md), and [docs/modules/nightly.md](modules/nightly.md)).
- **Nothing else is asked:** the owner is the repository's, visibility is read from GitHub, and the copyright holder defaults to the owner.

The files themselves arrive as the first sync PR ([step 4](#4-publish-and-grant-the-fleet-pat)): the writer copies them from the main commit the `stable` tag names, re-verified as green main history before any row consumes it ([build provenance](platform/build-provenance.md#provenance-is-the-commit-itself)).

**The list of platform files** is [files.yml](../files.yml) at the commit the `stable` tag names; [platform/sync/files.md](platform/sync/files.md#filesyml-reference) explains each entry's `class` and `when`. Four files matter later:

- **`.repo-platform.yml`** is the module selection's home, and its presence is what marks the repo as managed. Edit its `modules:` list in a PR, and the branch sync writes the module's files onto that PR ([changing the module selection](#changing-the-module-selection)). Repo-owned: the sync reads it and never rewrites it.
- **`.github/settings.local.yml`** is your settings overlay: identity keys, your own labels and rulesets. A starter, written once: every sync renders the managed `.github/settings.yml` from it and the fleet layers, and repo-platform's central run applies the rendered file ([settings](#5-settings-management)). Edit the overlay, never the rendered file.
- **`.gitignore`** is split: the platform owns the managed region (below), and repository-owned patterns go above the BEGIN marker or below the END marker ([split files](fleet-guidelines.md#split-files-the-managed-region)).
- **`.github/repo-platform-manifest.json`** is the ownership manifest, written by every sync: each platform-written path's class (`managed`, `split`, `starter`, or `mirror`) plus sha256 hashes of the managed content (a symlink mirror's hash covers its link target string). The `validate-managed-files` check blocks on any byte that differs from what the recorded commit's sync writes ([the managed files check](#the-managed-files-check)).

The managed region of `.gitignore` carries:

- **OS and editors:** Windows, macOS, Linux, VS Code, JetBrains.
- **The selected modules' sections:** the toolchains' github/gitignore templates, the fuzzer's `/.fuzz-failures/`.
- **Agent local state.**
- **Secrets files:** dotenv files anywhere in the tree (`.env.example` excepted), and private key material.
- **Scratch:** `*.tmp` files.
- **CI workspace paths:** every path a fleet action or workflow creates inside the checked-out workspace, the validator's platform checkout among them.

### Mirror copies of platform files

Some repos must carry byte-identical copies of a platform-written file at paths the platform does not own. The skills repo copies `LICENSE.md` into `template/` and into every skill folder, because a standalone skill install copies only that folder. Declare the copies in `.repo-platform.yml` and every sync rewrites them from the freshly written source, in the same PR:

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

- **`source`** names one file `files.yml` writes for the repository as class `managed` or `split`; mirroring repo-owned content is the repository's own job.
- **`kind: symlink`** places a relative link (`docs/AGENTS.md -> ../AGENTS.md`) for a tool that follows links and must never see a stale copy; `copy`, the default, writes the bytes.
- **A `*` in a target** matches within one path segment at sync time, so a new skill folder gets its copy with no declaration edit.
- **One path, one writer:** a target under `.github/workflows/` or at a path `files.yml` writes is refused, since workflow files are platform-written and a mirror there would be a second writer.
- **`**` is rejected:** nothing in the fleet needs recursive matching, and an unbounded walk over a target-controlled pattern is risk with no customer.
- **Clean copies auto-merge:** `written` and `current` targets are listed in the PR body but stay auto-merge-eligible. The declaration is repo-owned consent, and holding every LICENSE bump for review would defeat the auto-heal.
- **`validate-managed-files` judges each target as the writer does:** a regular file where a link is declared, a link where a copy is, or a link pointing elsewhere is a finding.

**Everything else is [platform/sync/mirrors.md](platform/sync/mirrors.md):** the fleet's own mirrors and how yours meet them, what the `plan` step refuses on the PR, each outcome at sync time, and the manifest record. The code is [sync/writer/mirrors.ts](../.github/scripts/sync/writer/mirrors.ts) and, for the rules both readers share, [actions/plan/mirrors.ts](../actions/plan/mirrors.ts).

## 3. Add checks to checks.yml

CI is split so the platform can keep improving its half while each repo keeps its own checks:

| File | Owner | Contents |
|---|---|---|
| `.github/workflows/ci.yml` | managed - sync updates it, don't edit; one byte-identical file for the whole fleet | a `checks` job calling checks.yml, a `ci` job calling repo-platform's [fleet-ci.yml](../.github/workflows/fleet-ci.yml)`@stable` (which reads the module selection from `.repo-platform.yml`), the `all-green` gate, and the static legs after it ([all-green.md](all-green.md#after-the-gate)) |
| `.github/workflows/checks.yml` | repo-owned (a starter, written once) | the repository's own test and lint jobs (multiple jobs, matrices, and further local reusable workflows all work); they run inside the gate through the `checks` job |
| `.github/workflows/post-green.yml` | repo-owned (a starter, written once) | the repository's own green-gated work, seeded as a no-op ([its contract](all-green.md#the-post-green-hook-in-every-managed-repository)) |
| `.github/workflows/update-release.yml`, `update-release-pr.yml` | repo-owned (a starter, written once) | the release hooks ci.yml's release legs call; seeded as no-ops in every repository, module or not ([the release pipeline](#the-release-pipeline-release-please)) |
| `.github/actions/site-build/action.yml` | repo-owned (a starter, written once) | the site-build hook the `site` leg runs from the checkout before the fleet deploys: the repository's own website build goes there; seeded as a no-op in every repository, module or not ([site.md](modules/site.md#the-hook-githubactionssite-buildactionyml)) |

**A starter is written once** and never touched by a sync after that, so when the platform INTRODUCES a starter at a path a repository already owns a file at, the writer leaves the repository's file alone and reports the row `unchanged`. Check the kept file against the interface its callers expect (the [sync-PR skill](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md) has the triage row).

**The `ci` job's checks** are listed in [what gates what](all-green.md#what-gates-what), each with where it runs, and [the all-green convention](all-green.md) says how the required `all-green` check judges both callers.

### The managed files check

The `validate-managed-files` step judges the repository against what repo-platform writes at the commit its manifest records ([platform/sync/manifest.md](platform/sync/manifest.md#judged-at-the-synced-commit)), in one sticky PR comment plus the step summary, run by the [validate-managed-files](../actions/validate-managed-files/action.yml) action.

- **Its vocabulary** is the recorded commit's `files.yml`, read by that commit's own writer: it judges the tree against the commit its LAST sync recorded. So a platform change reddens nothing until the repository syncs, and a registration change on a PR is red until the sync writes the module's files onto the branch ([changing the module selection](#changing-the-module-selection)).
- **The repository's side of every `when`** is the plan step's resolved visibility.

| Check | Blocks on |
|---|---|
| The recorded commit | a manifest whose own entry records no `commit`, or one that is not a full sha or that repo-platform does not hold (the checkout fails): not judged, the reason naming the remedy (merge the pending sync PR, or dispatch a sync). A commit repo-platform holds off `stable`'s history is judged, with a freshness warning |
| The sync's bytes | any byte that differs from what the recorded commit's writer writes over a copy of the repository (an edited managed file, a deleted or unmarked region, a replaced mirror, a registration change the sync has not carried yet), each path with a unified diff whose `+` lines are the sync's; and every reason the writer would hold the sync PR for, or its refusal |
| Release-please config | a `release-as` key in `release-please-config.json` ([the release pipeline](#the-release-pipeline-release-please)) |
| YAML | a YAML file anywhere in the repository that does not parse, carries a duplicate mapping key, or is a multi-document stream |
| Conflict markers | a line opening with `<<<<<<< ` or `>>>>>>> `, or reading `=======`, in a source, config, or markdown file (the validator's text suffixes); a fenced example of the markers counts |

- **Every finding blocks.** The verdict is ONE per run: clean, findings, or not judged. A validator that exits nonzero without a finding, exits zero with one, crashes before writing its report, times out, or dies on a signal is not judged, and not judged fails the check with the reason in the comment.

- **The report step always runs,** reads the verdict once, and exports it as the `integrity` output; a missing or malformed verdict exports failure. When no bun matching the action's pin is available the step exports the failure itself, with no verdict to read.

- **Freshness informs:** the job summary says whether `stable` has moved past the recorded commit; nothing fails for that, and a sync moves the commit under the stamp rule ([platform/sync/manifest.md](platform/sync/manifest.md#when-the-judged-commit-moves)).

### Changing the module selection

A module change is one PR when the branch sync carries the files onto it ([platform/sync/operator.md](platform/sync/operator.md#syncing-a-branch)). CI itself needs nothing written: ci.yml is the same file for every selection, and fleet-ci's `plan` step reads the new list on the next run. The sync writes the module's DATA files (its workflows, starters, and toolchain pins) and the manifest stamp onto the PR's branch as one commit:

```text
PR edits modules: in .repo-platform.yml
  -> plan reads the registration and checks it against the module data at the `stable` commit's root (an unknown module or a malformed file fails the job)
  -> validate-managed-files is red: it names each file the sync would write for the new selection, with the bytes
  -> gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<repo> -f branch=<pr-branch>
     (or the repo-platform:sync label on the PR, when the sync's whole diff touches no workflow file)
     one commit on the PR branch carries the files and the new manifest stamp
  -> with the label: approve the pushed head's run from the merge box (GitHub holds a repository-token push's run), or push a commit; the check is green
  -> review and merge the one PR
```

- **Why the label stops at workflow files:** the repository token cannot push one, and the label's comment names the paths when it refuses ([platform/sync/operator.md](platform/sync/operator.md#syncing-a-branch-by-label)).

- **What `plan` judges, on every event:** every module name in `.repo-platform.yml` must exist in the module data at the delivery commit's root beside the plan action, and the file must parse. It fails closed, so an unknown module or a malformed registration never merges through a PR.

- **A sync that meets an unknown name** in a registration fails in the same words, with no PR and a `[repo-platform] sync failed` issue on the repository.

- **Red on the first PR until the sync writes onto it:** validate-managed-files runs the recorded commit's writer over a copy of the tree with the edited registration, so the module's missing files are findings naming each path with its bytes. The branch sync brings them, the manifest with them, and the check turns green.

- **A module the recorded commit does not know yet** (added to the platform after this repository's last sync) is the writer's refusal instead, `unknown module(s)`, with the same way out: the sync runs at `stable`, knows the module, and moves the judge.

- **The other red to expect:** a module whose fleet-ci jobs read a file the sync has not written yet (a toolchain module's jobs read its version pin, `.bun-version` for `bun`). It stays red until the branch sync writes that file onto the PR.

- **Enforced by:** [actions/plan](../actions/plan/action.yml), called by fleet-ci.yml's `plan` step. The sync side is a dispatch of sync-repos.yml onto the PR's branch or the `repo-platform:sync` label ([platform/sync/operator.md](platform/sync/operator.md#syncing-a-branch-by-label)), or a dispatch after the merge ([the manual run](#the-manual-run)).

**The one edit no sync can carry** is a selection that flips a recorded path's class (dropping `custom-license` while a mirror still targets `LICENSE.md`, say). The writer refuses the declaration that now conflicts, so no sync, the branch sync included, restamps the record until it is gone. Stage it: drop the mirror declaration first, let a sync drop its record, then change the modules.

#### The manual run

`gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f manual=true` runs the ordinary sync against the repository's default branch and delivers the files as a sync PR that waits for review:

- **Same code path as a scheduled sync** ([platform/sync/operator.md](platform/sync/operator.md)): the writer selects by the registration on the default branch and replaces platform files whole; `manual=true` only keeps auto-merge off, so a clean report waits for a human too.

- **A broken target is re-synced the same way:** re-run the workflow, and the writer replaces platform files whole. There is no recovery mode.

- **A failed run surfaces where every sync failure does:** from the target checkout on, one `[repo-platform] sync failed` issue in the target repository carrying the log tails ([private repositories](platform/sync/private-repositories.md)); a failure before the target is resolved (the plan job, or a row's setup) is red in the run itself, and re-running the workflow is the remedy ([platform/sync/operator.md](platform/sync/operator.md)).

### What each module adds

**The community health files** (contributing guide, security policy, code of conduct, issue forms) are not written: GitHub serves them to every repository under the account from the account's `<owner>/.github` repository. A repository that needs a different text commits its own file, which GitHub prefers over the default; the issue forms count as one set, so any file under a repository's own .github/ISSUE_TEMPLATE folder replaces all of the default forms.

**Every repository receives:**

- the agent instructions (`AGENTS.md` with its `CLAUDE.md`, `.github/agents.md`, and `.github/copilot-instructions.md` symlinks)

- a repo-owned `copilot-setup-steps.yml` starter prefilled with installs for the selected toolchains

- a managed `.github/instructions/review.instructions.md` telling Copilot code review how to word its comments (problem first, then an example, then the fix; short plain sentences) and what earns one (a demonstrable defect in the diff; no speculative hardening, no unenforced style opinions)

- the managed `auto-assign.yml` (issues and PRs assigned to the repository owner)

- the settings overlay starter and the rendered `.github/settings.yml` described below

The modules add:

- **pr-title:** a managed `pr-title.yml` workflow running the `commit-names` job's own action (`validate-commit-names`) on the PR title, so a title it accepts is a subject that job accepts: a Conventional Commit with at most one scope, since titles become squash-commit subjects. Its own `pr-title` required check is installed by the module's settings layer ([the pr-title ruleset](settings.md#the-pr-title-ruleset)).
- **release-please:** arms the managed ci.yml's static `release` legs and lands the repo-owned release-please configuration ([the release pipeline](#the-release-pipeline-release-please) below).
- **bun:** the fleet's `.bun-version` pin ([toolchains.md](toolchains.md)). Dependabot's bun PRs install with the lockfile Dependabot wrote; a PR whose frozen install fails is fixed by hand, or by re-running Dependabot on it.
- **bun, a known limitation, accepted:** Dependabot's bun runner reads `bun.lock` lockfileVersion 1 only, while bun 1.4 writes version 2 ([dependabot-core#15848](https://github.com/dependabot/dependabot-core/issues/15848)). So a Dependabot bun PR that cannot be rebased is closed and the bump made by hand.
- **deno:** a managed `deno-audit.yml` that runs `deno audit --frozen --level high` at the root weekly, on lockfile-touching PRs, and on pushes to main that change `deno.lock`. It fails when any locked dependency (JSR or npm, transitive included) has a high or critical advisory, and when the root `deno.lock` is not committed.
- **rust:** a repo-owned `Cargo.toml` workspace root carrying the fleet's lint floor, and the cargo steps in `checks.yml`, `auto-format.yml`, and `copilot-setup-steps.yml` that gate on it. The floor, how a repository takes it, and the gate: [rust.md](modules/rust.md).
- **Any toolchain:** a repo-owned `auto-format.yml` starter, prefilled with each selected toolchain's formatter: label a PR `fix-lint` to get a formatting commit pushed to it. Width limits apply to code only: the deno step runs `deno fmt --prose-wrap preserve`, so markdown prose keeps its line breaks. [Re-triggering CI](#fix-commits-and-re-triggering-ci) applies.
- **fuzzer:** a repo-owned `nightly-fuzz.yml` starter - placeholder fuzz step, seeded replay inputs, failure artifact upload, [tracking-issue](modules/tracking-issues.md) filing, auto-close on green. Replace the placeholder with your fuzzer; [fuzzer.md](modules/fuzzer.md) has the contract.
- **nightly:** a repo-owned `nightly.yml` starter for checks too slow for every PR - placeholder step, tracking issue on failure, auto-close on the next green night ([nightly.md](modules/nightly.md)).

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

3. ci.yml's `publish-release` job calls [fleet-release-publish.yml](../.github/workflows/fleet-release-publish.yml)`@stable`, which attests build provenance for every asset on the draft and flips it live.

**The attestation** is a single `attestation.json` attached to the release, verifiable per asset with `gh attestation verify <asset> -R <owner>/<repo> --bundle attestation.json`. It is skipped for releases with no assets and for non-public repositories, which need Enterprise Cloud for attestations.

Around the cut itself:

- **The release PR is `GITHUB_TOKEN`'s:** GitHub lets a workflow open one only where the repository allows Actions to create and approve pull requests. The module's settings layer ([files/release-please/settings.yml](../files/release-please/settings.yml)) grants it, and the central apply sets it once the rendered settings land. Until then the release job is red with `GitHub Actions is not permitted to create or approve pull requests`.

- **The release-PR hook:** a run in which release-please creates or refreshes the release PR (a run finding no unreleased releasable commits triggers neither) calls the repo-owned `update-release-pr.yml` hook with the PR's number and head branch. Regenerating files that must ride in the release commit and updating version references go there. Its pushes with the default `GITHUB_TOKEN` do not re-trigger the PR's checks.

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

Repository settings are applied from repo-platform for every managed repository - the full model (six layers, merge dialect, apply semantics) is in [settings.md](settings.md). What the new repo sees:

- **The first sync writes the overlay `.github/settings.local.yml` once,** with `description` from the registration's `project.description` and `private` matching the repository's visibility. The rendered `.github/settings.yml` follows on every sync; [the starter and the rendered file](settings.md#the-starter-and-the-rendered-file) has what each holds.

- **Declare only the repo's OWN labels, rulesets, and overrides** in `.github/settings.local.yml`; [the merge dialect](settings.md#the-merge-dialect) says how they combine with the fleet layers, and the override layer's invariants win regardless.

- **Everything fleet-shaped stays out of the overlay,** so the labels dependabot auto-creates can never fall out of sync with [the label roster](settings.md#what-the-baseline-contains).

- **An overlay edit is one PR with the branch sync,** and the rendered file is never edited by hand ([editing your settings](settings.md#editing-your-settings)).

- **Nothing in the repository applies its settings:** repo-platform's central run does ([when it runs](settings.md#when-it-runs)).
