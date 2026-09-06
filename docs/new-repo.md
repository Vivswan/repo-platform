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

Copier asks for project name, description, a `modules`<!-- BEGIN GENERATED: module-roster (scripts/generate.ts - edit module.yml manifests, not this block) --> multiselect (any combination of `agents`, `bun`, `node`, `deno`, `uv`, `rust`, `pages`, `docs-site`, `release-please`, `issue-templates`, `skills`, `pr-title`, `auto-assign`, `fuzzer`, `nightly`, `settings-sync`, `custom-license`), follow-up parameters for modules that have them (see [docs/pages.md](pages.md), [docs/docs-site.md](docs-site.md), [docs/skills.md](skills.md), [docs/fuzzer.md](fuzzer.md), and [docs/nightly.md](nightly.md)), and visibility.<!-- END GENERATED: module-roster --> Answers are recorded in `.github/.copier-answers.yml`; never delete that file, `copier update` depends on it. Its `_commit` is the build commit the render came from, as a full 40-hex sha: validate-template rejects a short or tag-shaped value, because the fleet judges a render at exactly that template commit.

Trust assumption, stated plainly: `--trust` executes the branch tip's post-render hook on your machine, and unlike the sync pipeline (which [provenance-verifies the tip](build-provenance.md#the-provenance-proof) against a deterministic rebuild before consuming it), this local copy runs whatever the `build` tip is at that moment. The branch is MEANT to advance only through the [publish pipeline](build-provenance.md#who-can-write-refsheadsbuild), but a user-repo ruleset cannot restrict writers - so pin `--vcs-ref` to a reviewed build commit sha instead of the branch name if that matters in your setting.

Two files the render plants matter later:

| File | Role |
|---|---|
| `.repo-platform.yml` | The module selection's home from then on: edit its `modules:` list and the next sync PR applies the change. Its presence is what marks the repo as managed. Generated once and repo-owned (ownership class `starter`) - the sync reads it and never rewrites it. |
| `.github/repo-platform-manifest.json` | The ownership manifest: each template-landed path's class (`managed`, `split`, or `starter`) plus sha256 hashes of the managed content, stamped after each render. validate-template's INTEGRITY check blocks on drift against it, judged by the validator of the template commit the repo was rendered from ([the template check](#the-template-check)): managed content changed outside a sync, a listed managed file missing from the repo, or a roster path the manifest does not list. Severity follows the recorded `_commit`: a rule newer than the repo's build arrives as a latest-validator warning until the next sync PR merges. One state is an advisory instead: an entry carrying `"withheld": true`, which the sync stamps on a workflow it could not create because its token lacks the Workflows scope. A plain update honours the committed absence, so a recovery sync (`recover=recopy`) with the scope delivers the file, and the stamper clears the marker once the file exists. Its freshness report never blocks. |

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
- A `*` in a target matches within one path segment, resolved against the repo's tree at sync time: a literal final segment is written into every matched directory even when the file does not exist there yet, so a new skill folder gets its copy with no declaration edit. `**` is refused.
- Targets must stay inside the repository, must not be template-owned paths themselves (one path, one writer), and neither side may sit under `.github/workflows/` (workflow files ride the token-scope withhold machinery, so a mirror there cannot be promised). A refused declaration writes nothing, is named in the PR body, and holds the PR for manual review; clean mirror writes are listed in the PR body too but stay auto-merge-eligible.
- The declaration is read from the repo's latest commit - the committed truth, not whatever intermediate state a mid-sync working tree holds. The file itself is a repo-owned starter the sync never rewrites, so the declaration rides through every update and recovery untouched.
- Mirror targets get no manifest entries - they are repo-declared content, invisible to the retirement and parity machinery. The full contract lives in [materialize_mirrors.ts](../.github/scripts/sync/materialize_mirrors.ts).

## 3. Add checks to checks.yml

CI is split so the template can keep improving its half while each repo keeps its own checks:

| File | Owner | Contents |
|---|---|---|
| `.github/workflows/ci.yml` | managed - sync updates it, don't edit | a `checks` job calling checks.yml, plus a `ci` job calling repo-platform's [fleet-ci.yml](../.github/workflows/fleet-ci.yml)`@build` with the repo's module selection |
| `.github/workflows/checks.yml` | repo-owned (`_skip_if_exists`) | the repository's own test and lint jobs (multiple jobs, matrices, and further local reusable workflows all work); they run inside the gate through the `checks` job |
| `.github/workflows/post-green.yml` | repo-owned (`_skip_if_exists`) | the repository's own green-gated work (applying settings, refreshing generated artifacts): the managed `post-green` job calls it on every push to main whose gate passed, with the judged sha, before the release leg ([after the gate](all-green.md#after-the-gate)). Seeded as a no-op |

The `ci` job runs the standard checks (typography, file-size, commit-names, actionlint, gitleaks, yamllint; merged into one `base-checks` job on private repositories), `validate-template`, and the module checks (`dependency-review` and a per-language CodeQL matrix on public repos - CodeQL also needs a toolchain). The managed `all-green` job in the same ci.yml needs both callers and its own check run is the required `all-green` check - the [all-green convention](all-green.md).

### File size caps

| | |
|---|---|
| Rule | No file over its hard line cap, no code line over 256 characters: source 2000 lines, tests 3200 (a source file named `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*`, Rust's `*_tests.rs`, `tests.rs`, `proptests.rs`, or under `test/`, `tests/`, `__tests__/`), workflow yaml and `action.yml` 1000, shell 1000, markdown 1300. The warn tier at 60% of each (1200/1900/600/600/780, width 150) annotates without failing; a warn-wide line that is one string or regex literal (assigned, returned, or keyed) is left alone, since wrapping it means splitting the literal. |
| Why | A file past these sizes is several files wearing one name; a line past the width is unreadable in any review pane. The caps are generous on purpose: they catch drift, not style. |
| How | Split the file, or wrap the line. Exempt by construction: generated files (a generator comment in the first ten lines, `BEGIN GENERATED`/`END GENERATED` regions, goldens and vendored directories), files carrying repo-platform's managed header (the repository cannot fix them; the comment counts them, and repo-platform's own job judges the rendered goldens with that skip off so an oversize render fails at its source), lockfiles, json, non-workflow yaml, prose lines (one source line per paragraph is the fleet rule). A line that is one whitespace-free token (a URL, a sha, a jinja expression) is unbreakable and passes; a literal assigned on the same line is two tokens and does not. What must stay large goes in the repo-owned `.file-size-allow.local`, one path per line with a `# reason` a reader accepts: vendored or upstream-shaped, generated but missed by the header exemption, a split that would break an external contract, a file that predates the cap and names the PR its split waits on. "Large" or "legacy" alone is not a reason. An entry without a reason, or whose file is back under every cap, fails. |
| Enforced by | The `file-size` job in fleet-ci.yml ([actions/check-file-size](../actions/check-file-size/action.yml)): advisory across the fleet for now (`continue-on-error` on the job and the private `base-checks` step, so a hard finding annotates and comments without turning the PR red), gating in repo-platform's own ci.yml. The step summary is written on every outcome (findings, clean, or an error that stopped the check), findings also go to the log annotations, and on pull requests to one sticky PR comment, deleted when the tree is clean. |

### The template check

The `validate-template` job is three legs in one sticky PR comment plus the step summary, run by the [validate-template-report](../actions/validate-template-report/action.yml) action:

| Leg | Validator | Verdict |
|---|---|---|
| Integrity | repo-platform's build tree at the `_commit` recorded in `.github/.copier-answers.yml` - the template this repository was rendered from | Blocks: that validator's errors (managed content changed outside a sync, malformed managed YAML, a conditioned `ci` caller, and the like) |
| After your next sync | the build branch tip's validator (`validate-template@build`) | Warns: the rules the next sync PR brings, minus anything the integrity leg already said |
| Freshness | none - the integrity leg's one build-branch compare | Informs: how many build commits behind |

- Judging by the repository's own template commit is what keeps a template change from turning every fleet repo red before its sync PR lands; the tip's new rules arrive as warnings first and become the verdict once the sync PR merges.
- The integrity leg needs `_commit` to be the full 40-hex build sha the sync writes. A short or missing value fails the check with `merge this repository's pending template sync PR`; nothing resolves a short sha.
- The sha must also be a commit the `build` branch already contains, or the check fails without fetching anything: the answers file is PR-editable, and this is the same trust the `@build` action refs already place in that branch ([build provenance](build-provenance.md)).
- A PR may move `_commit` forward along the build branch, never back: the base ref's recorded `_commit` is the floor, and a PR whose `_commit` the build branch places behind it (or diverged from it) is not judged, with both shas in the reason. A base with no answers file yet sets no floor.
- The fetched tree runs on the bun its own `.bun-version` names, not on the current action's, so an older tree's lockfile is read by the bun that wrote it.
- Integrity is ONE verdict per run: clean, findings, or not judged. A validator that exits nonzero without a finding, exits zero with one, crashes before writing its report, times out, or dies on a signal is not judged, and not judged fails the check with the reason in the comment.
- The report step always runs, reads the verdict once, and exports it as the `integrity` output; a missing or malformed verdict exports failure. When no bun matching the action's pin is available the step exports the failure itself, with no verdict to read.
- Freshness reads the same compare that admitted the commit, published only once the whole admission (build-branch membership, then the vintage floor) has passed, so a refused commit shows the refusal there too rather than a distance.

### What each module adds

| Module | What lands |
| --- | --- |
| pr-title | A managed `pr-title.yml` workflow checking the PR title is a Conventional Commit (titles become squash-commit subjects), with its own `pr-title` required check installed by the module's settings layer ([the pr-title ruleset](settings.md#the-pr-title-ruleset)). |
| release-please | A `release` leg in the managed ci.yml plus the managed `release.yml` pipeline - [the release pipeline](#the-release-pipeline-release-please) below. |
| bun | A managed `dependabot-bun-lockfile.yml` that regenerates `bun.lock` from scratch on Dependabot's PRs and pushes the fix to the PR branch (Dependabot's own lockfile edits can leave stale nested entries that fail `bun install --frozen-lockfile`; the regeneration also refreshes every in-range pin, so most Dependabot PRs get a fix commit). [Re-triggering CI](#fix-commits-and-re-triggering-ci) applies. |
| deno | A managed `deno-audit.yml` that runs `deno audit` weekly, on lockfile-touching PRs, and on pushes to main that change `deno.lock`, failing when any locked dependency (JSR or npm, transitive included) has a known advisory. Every tracked `deno.lock` is audited, nested workspace lockfiles included. |
| any toolchain with a formatter (every one except rust) | A repo-owned `auto-format.yml` starter: label a PR `fix-lint` to get a formatting commit pushed to it, prefilled with each selected toolchain's formatter. Width limits apply to code only: the deno step runs `deno fmt --prose-wrap preserve`, so markdown prose keeps its line breaks. [Re-triggering CI](#fix-commits-and-re-triggering-ci) applies. |
| agents | A repo-owned `copilot-setup-steps.yml` starter (environment setup for the Copilot coding agent), prefilled with installs for the selected toolchains, plus a managed `.github/instructions/review.instructions.md` telling Copilot code review how to word its comments (problem first, then an example, then the fix; short plain sentences) and what earns one (a demonstrable defect in the diff; no speculative hardening, no unenforced style opinions). |
| fuzzer | A repo-owned `nightly-fuzz.yml` starter - placeholder fuzz step, seeded replay inputs, failure artifact upload, [tracking-issue](tracking-issues.md) filing, auto-close on green. Replace the placeholder with your fuzzer; [fuzzer.md](fuzzer.md) has the contract. |
| nightly | A repo-owned `nightly.yml` starter for checks too slow for every PR - placeholder step, tracking issue on failure, auto-close on the next green night ([nightly.md](nightly.md)). |

### Fix commits and re-triggering CI

Two of those workflows push fix commits to PR branches, and a push made with the default token (`github.token` / `GITHUB_TOKEN`) starts no workflows - the required `all-green` check would sit unreported on the new head. Both jobs post one sticky PR comment (edited in place on later runs) and a run warning saying so; close/reopen the PR to re-run its checks. To make fix commits re-trigger CI automatically:

- bun lockfile fixes: register `REPO_PLATFORM_TOKEN` as a *Dependabot* secret - a fine-grained token scoped to that one repo's Contents:RW is enough; do not put the fleet PAT in a downstream repo.
- auto-format: a PAT with Contents:RW would work, but any same-repo PR's formatter tooling runs next to that token, so the starter deliberately does not wire one in.

### The release pipeline (release-please)

The `release` leg in the managed ci.yml - `needs: [all-green, post-green]`, released only by a green gate and a green repo-owned post-green hook on a push to main, with the judged commit passed through ([all-green.md](all-green.md#after-the-gate)) - calls the managed `release.yml`. GitHub releases are immutable once published, so every release moves through three stages in one workflow run (no PAT needed to chain them), always draft-first:

1. release-please cuts the release as a draft with its tag already forced.
2. The repo-owned `update-release.yml` hook is called with the tag: packaging, asset uploads, and note edits go there, and publishing waits for every job in it.
3. The managed publish stage attests build provenance for every asset on the draft - a single `attestation.json` attached to the release, verifiable per asset with `gh attestation verify <asset> -R <owner>/<repo> --bundle attestation.json` (skipped for releases with no assets and for non-public repositories, which need Enterprise Cloud for attestations) - and flips it live.

Around the cut itself:

- A run in which release-please creates or refreshes the release PR (a run finding no unreleased releasable commits triggers neither) calls the repo-owned `update-release-pr.yml` hook with the PR's number and head branch: regenerating files that must ride in the release commit and updating version references go there. Its pushes with the default `GITHUB_TOKEN` do not re-trigger the PR's checks; with `REPO_PLATFORM_TOKEN` they do.
- The `release-please-config.json` and `.release-please-manifest.json` starters are repo-owned too (release-please updates the manifest via release PRs).
- To force a specific version, merge an empty commit with a footer: `git commit --allow-empty -m "chore: release 5.0.0" -m "Release-As: 5.0.0"`. release-please honours it once and leaves nothing behind. Never set `release-as` in release-please-config.json: the key survives the release it pinned, so the next release PR proposes the same version again, and with `force-tag-creation` it would move the published tag. The fleet's validate-template check rejects the key.

## 4. Publish and register

```bash
gh repo create Vivswan/my-project --public --source . --push
```

That is the whole repo-side setup, plus one grant: give the fleet PAT access to the new repository (its repository access list) - discovery only enrolls repos the token can write to. The `repos.yml` wildcard then picks it up, `.repo-platform.yml` opts it into push sync, and update PRs start arriving on the weekly cron (`gh workflow run sync-repos.yml -f repo=Vivswan/my-project -R Vivswan/repo-platform` syncs it immediately).

The `exclude:` list in `repos.yml` is only for opting a discovered repo OUT of management; a new managed repo touches nothing in repo-platform.

## 5. Settings management (the settings-sync module)

Repository settings are applied from repo-platform, and selecting the `settings-sync` module is the whole opt-in - the full model (six layers, merge dialect, apply semantics) is in [settings.md](settings.md). What the new repo sees:

- The module renders `.github/settings.yml` ONCE as a repo-owned identity starter (`description`, `homepage`, `topics`, `private`, seeded from the copier answers) plus commented examples. Everything fleet-shaped stays out of the file, so the labels dependabot auto-creates can never fall out of sync with the roster: `dependencies` (color `0366d6`) and `github_actions` (`000000`) always, plus one label per toolchain the repo's dependabot.yml covers:<!-- BEGIN GENERATED: dependabot-labels (scripts/generate.ts - edit module.yml manifests, not this block) --> `javascript` (`168700`) for bun and npm, `deno` (`70ffaf`) for deno, `python:uv` (`2b67c6`) for uv, `rust` (`000000`) for cargo.<!-- END GENERATED: dependabot-labels -->
- Declare only the repo's OWN labels, rulesets, and overrides in settings.yml; [the merge dialect](settings.md#the-merge-dialect) says how they combine with the fleet layers, and the override layer's invariants win regardless.
- The module also renders a `settings-sync.yml` workflow for push-time self-apply (needs a repo-scoped PAT; warns and skips without one); the central heal applies the repo's settings either way.
- A repo without the module has unmanaged settings: nothing installs or heals the `main` ruleset (so `all-green` may not be a required check) and labels are never reconciled.
