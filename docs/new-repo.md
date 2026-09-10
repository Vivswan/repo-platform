---
order: 10
group: Start here
---

# Creating a new repository

The template is standards-only: the native toolchain owns the project skeleton, repo-platform layers CI conventions, settings, gitignore, and agent instructions on top. There is nothing to configure in the new repo itself - no sync workflow, no secrets. Once the repo exists on GitHub with `.repo-platform.yml` on its default branch, repo-platform's push sync picks it up.

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

Copier asks for project name, description, a `modules`<!-- BEGIN GENERATED: module-roster (scripts/generate.ts - edit module.yml manifests, not this block) --> multiselect (any combination of `bun`, `node`, `deno`, `uv`, `rust`, `pages`, `docs-site`, `release-please`, `issue-templates`, `skills`, `pr-title`, `fuzzer`, `nightly`, `custom-license`), follow-up parameters for modules that have them (see [docs/pages.md](pages.md), [docs/docs-site.md](docs-site.md), [docs/skills.md](skills.md), [docs/fuzzer.md](fuzzer.md), and [docs/nightly.md](nightly.md)), and visibility.<!-- END GENERATED: module-roster --> Two more questions, `homepage` and `topics`, seed the settings starter.

Copier records the answers in `.github/.copier-answers.yml`, the render's record only until the first sync:

- The operator's cutover derives the registration `.repo-platform.yml` from it ([sync.md](sync.md#cutover)).
- The same sync PR deletes it through the `retired` entry in `files.yml`; from then on the registration is the only record.
- Until that PR merges, keep it: its `_commit` is the build commit the render came from, as a full 40-hex sha, and validate-template rejects a short or tag-shaped value, because the fleet judges a render at exactly that template commit.

Trust assumption, stated plainly: `--trust` executes the branch tip's post-render hook on your machine, and unlike the sync pipeline (which [provenance-verifies the tip](build-provenance.md#the-provenance-proof) against a deterministic rebuild before consuming it), this local copy runs whatever the `build` tip is at that moment. The branch is MEANT to advance only through the [publish pipeline](build-provenance.md#who-can-write-refsheadsbuild), but a user-repo ruleset cannot restrict writers - so pin `--vcs-ref` to a reviewed build commit sha instead of the branch name if that matters in your setting.

Three files the render plants matter later:

| File | Role |
|---|---|
| `.repo-platform.yml` | The module selection's home from then on: edit its `modules:` list in a PR; the sync PR carrying the render follows the merge ([changing the module selection](#changing-the-module-selection)). Its presence is what marks the repo as managed. Generated once and repo-owned (ownership class `starter`) - the sync reads it and never rewrites it. |
| `.gitignore` | Split: the managed region carries the OS sections, the selected toolchains' github/gitignore sections, agent local state, and the CI workspace paths repo-platform's workflow steps create inside the checked-out workspace (`/results.sarif`, `/.fuzz-failures/`), so a stray local file of the same name can never be committed and later collide with the CI step that creates it. Repository-owned patterns go above the BEGIN marker or below the END marker ([split files](fleet-guidelines.md#split-files-the-managed-region)). |
| `.github/repo-platform-manifest.json` | The ownership manifest: each platform-written path's class (`managed`, `split`, `starter`, `mirror`, or `link`) plus sha256 hashes of the managed content (a link's hash covers its target string), stamped after each render. validate-template's INTEGRITY check blocks on drift against it, judged by the validator of the template commit the repo was rendered from ([the template check](#the-template-check)): managed content changed outside a sync, a listed managed file missing from the repo, or a roster path the manifest does not list. Severity follows the recorded `_commit`: a rule newer than the repo's build arrives as a latest-validator warning until the next sync PR merges. Its freshness report never blocks. |

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
| `.github/settings.yml` | starter | public |
| `.github/settings.yml` | starter | private |
| `.github/workflows/ci.yml` | managed | always |
| `.github/workflows/checks.yml` | starter | always |
| `.github/workflows/post-green.yml` | starter | always |
| `.github/workflows/update-release.yml` | starter | always |
| `.github/workflows/update-release-pr.yml` | starter | always |
| `.github/workflows/copilot-setup-steps.yml` | starter | always |
| `.gitleaks.toml` | starter | always |
| `.yamllint` | managed | always |
| `.github/workflows/auto-assign.yml` | managed | any of `bun`, `node`, `deno`, `uv`; public |
| `.github/workflows/auto-assign.yml` | managed | private |
| `.github/workflows/auto-assign.yml` | managed | without `bun`, `node`, `deno`, `uv`; public |
| `.github/workflows/auto-format.yml` | starter | any of `bun`, `node`, `deno`, `uv` |
| `.typography-allow` | managed | without `release-please` |
| `.typography-allow` | managed | modules: `release-please` |
| `AGENTS.md` | split | without `bun`, `node`, `deno`, `uv`, `rust` |
| `AGENTS.md` | split | any of `bun`, `node`, `deno`, `uv`, `rust` |
| `LICENSE.md` | split | without `custom-license` |
| `CLAUDE.md` | link | always |
| `.github/agents.md` | link | always |
| `.github/copilot-instructions.md` | link | always |
| `.bun-version` | managed | modules: `bun` |
| `.github/workflows/dependabot-bun-lockfile.yml` | managed | modules: `bun` |
| `.node-version` | managed | modules: `node` |
| `.dvmrc` | managed | modules: `deno` |
| `.github/workflows/deno-audit.yml` | managed | modules: `deno` |
| `.github/workflows/pages.yml` | managed | modules: `pages` |
| `.github/workflows/docs-site.yml` | managed | modules: `docs-site` |
| `.release-please-manifest.json` | starter | modules: `release-please` |
| `release-please-config.json` | starter | modules: `release-please` |
| `.claude-plugin/marketplace.json` | starter | modules: `skills` |
| `.claude-plugin/plugin.json` | starter | modules: `skills` |
| `.github/workflows/validate-skills.yml` | managed | modules: `skills` |
| `.github/workflows/pr-title.yml` | managed | modules: `pr-title` |
| `.github/workflows/nightly-fuzz.yml` | starter | modules: `fuzzer` |
| `.github/workflows/nightly.yml` | starter | modules: `nightly` |
<!-- END GENERATED: files-table -->

### Mirror copies of rendered files

Some repos must carry byte-identical copies of a rendered file at paths the template does not own - the skills repo copies `LICENSE.md` into `template/` and into every skill folder, because a standalone skill install copies only that folder. Declare the copies in `.repo-platform.yml` and every sync rewrites them from the freshly rendered source, in the same PR:

```yaml
mirrors:
  - source: LICENSE.md
    targets:
      - template/LICENSE.md
      - skills/*/LICENSE.md
```

- `source` names one template-rendered file (listed in the ownership manifest as class `managed` or `split`); mirroring repo-owned content is the repository's own job.
- A `*` in a target matches within one path segment, resolved against the repo's tree at sync time: a literal final segment is written into every matched directory even when the file does not exist there yet, so a new skill folder gets its copy with no declaration edit. `**` is refused: nothing in the fleet needs recursive matching, and an unbounded walk over a target-controlled pattern is risk with no customer.
- Targets must stay inside the repository, must not be template-owned paths themselves (one path, one writer), and neither side may sit under `.github/workflows/` (workflow files are template-owned, managed renders or generated-once starters, so a mirror there would be a second writer). No two sources may claim one target and no target may be a path prefix of another; both sides of either conflict are refused, so declaration order never chooses the winner. A symlink at either side's path or among its ancestors is refused too: following one would carry the read or the write outside the checkout.
- A refused declaration writes nothing, is named in its own PR-body section, and holds the PR for manual review; it never fails the sync, because a red run would block the very PR a human fixes the declaration in, and the refused mirrors are merely stale. Clean mirror writes are listed in the PR body too (the diff must explain itself) but stay auto-merge-eligible: the declaration is repo-owned consent, and holding every LICENSE bump for review would defeat the auto-heal.
- The declaration is read from the repo's latest commit - the committed truth, not whatever intermediate state a mid-sync working tree holds. The file itself is a repo-owned starter the sync never rewrites, so the declaration rides through every update and recovery untouched.
- Mirror targets get no manifest entries - they are repo-declared content, invisible to the retirement and parity machinery (the validator ignores unlisted paths, the tail tripwire walks only manifest entries); a target that is itself a manifest-listed path is refused for the same reason. The implementation: [materialize_mirrors.ts](https://github.com/Vivswan/repo-platform/blob/main/.github/scripts/sync/materialize_mirrors.ts).

## 3. Add checks to checks.yml

CI is split so the template can keep improving its half while each repo keeps its own checks:

| File | Owner | Contents |
|---|---|---|
| `.github/workflows/ci.yml` | managed - sync updates it, don't edit; one byte-identical file for the whole fleet | a `checks` job calling checks.yml, a `ci` job calling repo-platform's [fleet-ci.yml](../.github/workflows/fleet-ci.yml)`@build` (which reads the module selection from `.repo-platform.yml`), the `all-green` gate, and the static legs after it ([all-green.md](all-green.md#after-the-gate)) |
| `.github/workflows/checks.yml` | repo-owned (`_skip_if_exists`) | the repository's own test and lint jobs (multiple jobs, matrices, and further local reusable workflows all work); they run inside the gate through the `checks` job |
| `.github/workflows/post-green.yml` | repo-owned (`_skip_if_exists`) | the repository's own green-gated work (applying settings, refreshing generated artifacts): the managed `post-green` job calls it on every push to main whose gate passed, with the judged sha, before the release leg ([after the gate](all-green.md#after-the-gate)). Seeded as a no-op |
| `.github/workflows/update-release.yml`, `update-release-pr.yml` | repo-owned (`_skip_if_exists`) | the release hooks ci.yml's release legs call; seeded as no-ops in every repository, module or not, because GitHub resolves a called `./` workflow at run creation ([the release pipeline](#the-release-pipeline-release-please)) |

A `_skip_if_exists` file is generated once and never touched by a sync after that, so when the template INTRODUCES a starter at a path a repository already owns a file at (post-green.yml on its rollout), copier keeps the repository's file with no conflict and no diff. The sync then holds that repository's PR for review, naming the file, the template files that call it, and the template's starter, so the kept file can be checked against the interface the callers expect (the [sync-PR skill](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md) has the triage row).

The `ci` job runs the standard checks (typography, file-size, commit-names, actionlint, gitleaks, yamllint, as the steps of one `base-checks` job whose judge step lists every failed check), `validate-template`, and the module checks (`dependency-review` and a per-language CodeQL matrix on public repos - CodeQL also needs a toolchain). The managed `all-green` job in the same ci.yml needs both callers and its own check run is the required `all-green` check - the [all-green convention](all-green.md).

### File size caps

| | |
|---|---|
| Rule | No file over its hard line cap, no code line over 256 characters: source 2000 lines, tests 3200 (a source file named `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*`, Rust's `*_tests.rs`, `tests.rs`, `proptests.rs`, or under `test/`, `tests/`, `__tests__/`), workflow yaml and `action.yml` 1000, shell 1000, markdown 1300. The warn tier (80% of each line cap: 1600/2560/800/800/1040; width 150) annotates without failing; a warn-wide line that is one string or regex literal (assigned, returned, or keyed) is left alone, since wrapping it means splitting the literal. Comment blocks have one warn-only cap, never a failure: a block over 10 lines warns, a file header comment (the first block, when nothing but a shebang precedes it) over 25 warns. A block is a run of whole-line comments, `//` and `/* */` or `#` per the file's extension, and a `/* */` comment counts every line between its delimiters; a blank line or a code line between comments ends the block, a line with code on it is code (an inline comment after it is not a block), and markdown is prose. A comment line `comment-cap: ignore <reason>` inside a block (or directly above it, which makes it part of the block) exempts that block alone; a bare marker exempts nothing and warns itself. |
| Why | A file past these sizes is several files wearing one name; a line past the width is unreadable in any review pane; a comment past its cap is narration or a workaround defense, and the code is the source of truth. The caps are generous on purpose: they catch drift, not style. |
| How | Split the file, wrap the line, or shorten the comment (or mark the block `comment-cap: ignore <reason>` when it must stay long: a license text, an upstream-shaped header). Exempt by construction: generated files (a comment in the first ten lines declaring it so, such as `generated by X` or `do not edit`; a comment that merely names a generator is not a declaration; `BEGIN GENERATED`/`END GENERATED` regions, goldens and vendored directories), files carrying repo-platform's managed header (the repository cannot fix them; the comment counts them, and repo-platform's own job judges the rendered goldens with that skip off so an oversize render fails at its source), lockfiles, json, non-workflow yaml, prose lines (one source line per paragraph is the fleet rule). A line that is one whitespace-free token (a URL, a sha, a jinja expression) is unbreakable and passes; a literal assigned on the same line is two tokens and does not. What must stay large goes in the repo-owned `.file-size-allow.local`, one path per line with a `# reason` a reader accepts: vendored or upstream-shaped, generated but missed by the header exemption, a split that would break an external contract, a file that predates the cap and names the PR its split waits on. "Large" or "legacy" alone is not a reason. An entry without a reason, or whose file has no finding left (under every cap, no bare exemption marker), fails. A repository that packages from its root (a VS Code extension's VSIX, an npm package with no `files` field) lists the allowlist in its packaging ignore file (`.vscodeignore`, `.npmignore`), or it ships as content. |
| Enforced by | The `file-size` step of fleet-ci.yml's `base-checks` job ([actions/check-file-size](../actions/check-file-size/action.yml)): advisory across the fleet for now (`continue-on-error` on the step, so a hard finding annotates and comments without turning the PR red; the judge step reports it as advisory), gating in repo-platform's own ci.yml. The step summary is written on every outcome (findings, clean, or an error that stopped the check), findings also go to the log annotations, and on pull requests to one sticky PR comment, deleted when the tree is clean. |

### The template check

The `validate-template` job is three legs in one sticky PR comment plus the step summary, run by the [validate-template-report](../actions/validate-template-report/action.yml) action:

| Leg | Validator | Verdict |
|---|---|---|
| Integrity | repo-platform's build tree at the `_commit` recorded in `.github/.copier-answers.yml` - the template this repository was rendered from | Blocks: that validator's errors (managed content changed outside a sync, malformed managed YAML, a conditioned `ci` caller, and the like) |
| After your next sync | the build branch tip's validator (run by the report action from its own `validator/` script directory on the build branch) | Warns: the rules the next sync PR brings, minus anything the integrity leg already said |
| Freshness | none - the integrity leg's one build-branch compare | Informs: how many build commits behind |

- Judging by the repository's own template commit is what keeps a template change from turning every fleet repo red before its sync PR lands; the tip's new rules arrive as warnings first and become the verdict once the sync PR merges.
- The integrity leg needs `_commit` to be the full 40-hex build sha the sync writes. A short or missing value fails the check with `merge this repository's pending template sync PR`; nothing resolves a short sha.
- The sha must also be a commit the `build` branch already contains, or the check fails without fetching anything: the answers file is PR-editable, and this is the same trust the `@build` action refs already place in that branch ([build provenance](build-provenance.md)).
- A PR may move `_commit` forward along the build branch, never back: the base ref's recorded `_commit` is the floor, and a PR whose `_commit` the build branch places behind it (or diverged from it) is not judged, with both shas in the reason. A base with no answers file yet sets no floor.
- The fetched tree runs on the bun its own `.bun-version` names, not on the current action's, so an older tree's lockfile is read by the bun that wrote it.
- Integrity is ONE verdict per run: clean, findings, or not judged. A validator that exits nonzero without a finding, exits zero with one, crashes before writing its report, times out, or dies on a signal is not judged, and not judged fails the check with the reason in the comment.
- The report step always runs, reads the verdict once, and exports it as the `integrity` output; a missing or malformed verdict exports failure. When no bun matching the action's pin is available the step exports the failure itself, with no verdict to read.
- Freshness reads the same compare that admitted the commit, published only once the whole admission (build-branch membership, then the vintage floor) has passed, so a refused commit shows the refusal there too rather than a distance.

### Changing the module selection

A module change is two PRs in the managed repository: the registration edit, then the sync PR carrying its render. CI itself needs no render: ci.yml is the same file for every selection, and fleet-ci's `plan` job reads the new list on the next run, validating the registration on the first PR. The module's DATA files (its workflows, starters, and toolchain pins) are what the second PR carries, written by the sync once the first has merged:

```text
PR edits modules: in .repo-platform.yml
  -> plan reads the registration and checks it against the build's module data (an unknown module or a malformed file fails the job)
  -> validate-template RED when the module adds managed files or a toolchain pin: the tree does not carry them yet
     the owner lands the registration edit past it (the render cannot precede it: the sync reads the default branch), then
             gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f manual=true
  -> the sync opens a PR carrying the render (the writer replaces platform files whole), held for review
  -> review and merge the sync PR; validate-template green
```

| | |
|---|---|
| What the PR check judges | The `plan` job runs on every event and reads `.repo-platform.yml` (the recorded answers are the fallback), checking it against the module data the build branch ships beside the plan action: every module name must exist and the file must parse. It fails closed, so an unknown module or a malformed registration never reaches the sync. |
| What stays red until the sync PR lands | `validate-template` reads the edited registration too: a module that adds managed files fails the manifest check on the entries the tree lacks, and a toolchain module fails the registration check on its missing pin dotfile. Nothing on the PR compares the tree against a render of the new selection; the sync PR brings the files, and the check goes green on it. |
| Enforced by | [actions/plan](../actions/plan/action.yml), called by fleet-ci.yml's `plan` job. The sync side is a manual run of sync-repos.yml ([the manual run](#the-manual-run)). |

#### The manual run

`gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f manual=true` runs the ordinary sync against the repository's default branch and delivers the render as a sync PR that waits for review:

- Same code path as a weekly sync ([sync.md](sync.md#the-operator)): the writer renders the selection the registration on the default branch carries and replaces platform files whole; `manual=true` only keeps auto-merge off, so a clean render waits for a human too.
- A broken target is re-synced the same way: re-run the workflow, and the writer replaces platform files whole. There is no recovery mode.
- A failed run surfaces where every sync failure does: from the target checkout on, one `[repo-platform] sync failed` issue in the target repository carrying the log tails ([private-repos.md](private-repos.md)); a failure before the target is resolved (the plan job, or a row's setup) is red in the run itself, and re-running the workflow is the remedy ([sync.md](sync.md#the-operator)).

### What each module adds

The community health files (contributing guide, security policy, code of conduct, issue forms) are not rendered: GitHub serves them to every repository under the account from [Vivswan/.github](https://github.com/Vivswan/.github). A repository that needs a different text commits its own file, which GitHub prefers over the default; the issue forms count as one set, so any file under a repository's own `.github/ISSUE_TEMPLATE/` replaces all of the default forms.

Every render carries the agent instructions (`AGENTS.md` with its `CLAUDE.md`, `.github/agents.md`, and `.github/copilot-instructions.md` symlinks), a repo-owned `copilot-setup-steps.yml` starter prefilled with installs for the selected toolchains, a managed `.github/instructions/review.instructions.md` telling Copilot code review how to word its comments (problem first, then an example, then the fix; short plain sentences) and what earns one (a demonstrable defect in the diff; no speculative hardening, no unenforced style opinions), the managed `auto-assign.yml` (issues, PRs, and code scanning alerts assigned to the owner), and the settings starter described below. The modules add:

| Module | What lands |
| --- | --- |
| pr-title | A managed `pr-title.yml` workflow checking the PR title is a Conventional Commit (titles become squash-commit subjects), with its own `pr-title` required check installed by the module's settings layer ([the pr-title ruleset](settings.md#the-pr-title-ruleset)). |
| release-please | Arms the managed ci.yml's static `release` legs and lands the repo-owned release-please configuration - [the release pipeline](#the-release-pipeline-release-please) below. |
| bun | A managed `dependabot-bun-lockfile.yml` that calls repo-platform's `dedupe-bun-lockfile` action at `@build` to regenerate `bun.lock` from scratch on Dependabot's PRs and push the fix to the PR branch (Dependabot's own lockfile edits can leave stale nested entries that fail `bun install --frozen-lockfile`; the regeneration also refreshes every in-range pin, so most Dependabot PRs get a fix commit). [Re-triggering CI](#fix-commits-and-re-triggering-ci) applies. |
| deno | A managed `deno-audit.yml` that runs `deno audit` weekly, on lockfile-touching PRs, and on pushes to main that change `deno.lock`, failing when any locked dependency (JSR or npm, transitive included) has a known advisory. Every tracked `deno.lock` is audited, nested workspace lockfiles included. |
| any toolchain with a formatter (every one except rust) | A repo-owned `auto-format.yml` starter: label a PR `fix-lint` to get a formatting commit pushed to it, prefilled with each selected toolchain's formatter. Width limits apply to code only: the deno step runs `deno fmt --prose-wrap preserve`, so markdown prose keeps its line breaks. [Re-triggering CI](#fix-commits-and-re-triggering-ci) applies. |
| fuzzer | A repo-owned `nightly-fuzz.yml` starter - placeholder fuzz step, seeded replay inputs, failure artifact upload, [tracking-issue](tracking-issues.md) filing, auto-close on green. Replace the placeholder with your fuzzer; [fuzzer.md](fuzzer.md) has the contract. |
| nightly | A repo-owned `nightly.yml` starter for checks too slow for every PR - placeholder step, tracking issue on failure, auto-close on the next green night ([nightly.md](nightly.md)). |

### Fix commits and re-triggering CI

Two of those workflows push fix commits to PR branches, and a push made with the default token (`github.token` / `GITHUB_TOKEN`) starts no workflows - the required `all-green` check would sit unreported on the new head. Both jobs post one sticky PR comment (edited in place on later runs) and a run warning saying so; close/reopen the PR to re-run its checks. To make fix commits re-trigger CI automatically:

- bun lockfile fixes: register `REPO_PLATFORM_TOKEN` as a *Dependabot* secret - a fine-grained token scoped to that one repo's Contents:RW is enough; do not put the fleet PAT in a downstream repo.
- auto-format: a PAT with Contents:RW would work, but any same-repo PR's formatter tooling runs next to that token, so the starter deliberately does not wire one in.

### The release pipeline (release-please)

The `release` leg in the managed ci.yml - needing the gate and the repo-owned post-green hook, released only by a green gate and a green hook on a push to main with the judged commit passed through, and armed only where `.repo-platform.yml` selects the module ([all-green.md](all-green.md#after-the-gate)) - calls repo-platform's [fleet-release.yml](../.github/workflows/fleet-release.yml)`@build`. GitHub releases are immutable once published, so every release moves through three stages in one workflow run (no PAT needed to chain them), always draft-first:

1. release-please cuts the release as a draft with its tag already forced.
2. ci.yml's `update-release` job calls the repo-owned `update-release.yml` hook with the tag: packaging, asset uploads, and note edits go there, and publishing waits for every job in it.
3. ci.yml's `publish-release` job calls [fleet-release-publish.yml](../.github/workflows/fleet-release-publish.yml)`@build`, which attests build provenance for every asset on the draft - a single `attestation.json` attached to the release, verifiable per asset with `gh attestation verify <asset> -R <owner>/<repo> --bundle attestation.json` (skipped for releases with no assets and for non-public repositories, which need Enterprise Cloud for attestations) - and flips it live.

Around the cut itself:

- A run in which release-please creates or refreshes the release PR (a run finding no unreleased releasable commits triggers neither) calls the repo-owned `update-release-pr.yml` hook with the PR's number and head branch: regenerating files that must ride in the release commit and updating version references go there. Its pushes with the default `GITHUB_TOKEN` do not re-trigger the PR's checks; with `REPO_PLATFORM_TOKEN` they do.
- Both hooks are seeded in every repository, module or not (a called `./` workflow must exist at run creation even when its job skips); without the module they are never called.
- The `release-please-config.json` and `.release-please-manifest.json` starters are repo-owned too (release-please updates the manifest via release PRs).
- To force a specific version, merge an empty commit with a footer: `git commit --allow-empty -m "chore: release 5.0.0" -m "Release-As: 5.0.0"`. release-please honours it once and leaves nothing behind. Never set `release-as` in release-please-config.json: the key survives the release it pinned, so the next release PR proposes the same version again, and with `force-tag-creation` it would move the published tag. The fleet's validate-template check rejects the key.

## 4. Publish and register

```bash
gh repo create Vivswan/my-project --public --source . --push
```

That is the whole repo-side setup, plus one grant: give the fleet PAT access to the new repository (its repository access list) - the PAT's grant is the only fleet-membership fact, so that access IS the enrollment. `.repo-platform.yml` opts it into push sync, and update PRs start arriving on the weekly cron (`gh workflow run sync-repos.yml -f repo=Vivswan/my-project -R Vivswan/repo-platform` syncs it immediately).

A new managed repo touches nothing in repo-platform: there is no fleet list to edit.

## 5. Settings management

Repository settings are applied from repo-platform for every managed repository - the full model (six layers, merge dialect, apply semantics) is in [settings.md](settings.md). What the new repo sees:

- The render carries `.github/settings.yml` ONCE as a repo-owned identity starter (`description`, `homepage`, `topics`, `private`, seeded from the copier answers; a sync that renders it for a repository whose answers never recorded `homepage`/`topics` seeds those two from the live repository) plus commented examples. Everything fleet-shaped stays out of the file, so the labels dependabot auto-creates can never fall out of sync with the roster: `dependencies` (color `0366d6`) and `github_actions` (`000000`) always, plus one label per toolchain the repo's dependabot.yml covers:<!-- BEGIN GENERATED: dependabot-labels (scripts/generate.ts - edit module.yml manifests, not this block) --> `javascript` (`168700`) for bun and npm, `deno` (`70ffaf`) for deno, `python:uv` (`2b67c6`) for uv, `rust` (`000000`) for cargo.<!-- END GENERATED: dependabot-labels -->
- Declare only the repo's OWN labels, rulesets, and overrides in settings.yml; [the merge dialect](settings.md#the-merge-dialect) says how they combine with the fleet layers, and the override layer's invariants win regardless.
- Nothing in the repository applies its settings: repo-platform's central run does, after every green main merge there and nightly.
