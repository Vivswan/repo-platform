---
name: repo-platform-add-module
description: 'Add or remove a Vivswan/repo-platform module in a managed repository - edit the modules list, set module parameters, get the sync PR, and finish the companion steps. Use when someone says "add a module", "enable the fuzzer", "add nightly CI to this repo", "turn on pages", "host skills in this repo", "add the bun toolchain", "add Python support to this repo", "add Rust support", "start cutting releases here", "publish the docs site", "check PR titles on this repo", "remove a module", "drop the fuzzer", "disable nightly", asks "what modules does this repo have", or asks how to change a module parameter like nightly_label, fuzzer_label, skills_dir, or the pages build command.'
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: Adding or Removing a Module

Module selection is repo-owned: the top-level `modules:` list in the repository's own `.repo-platform.yml`. Change it in a PR, and one dispatch pushes the render of the new selection onto that same PR - no edits in repo-platform are needed: the managed settings baseline (labels, rulesets) follows the module selection automatically at apply time.

Work in this order, always:

1. Edit `modules:` in `.repo-platform.yml` (and any module parameter in `.github/.copier-answers.yml`, same PR) on a branch and open the PR. Its `module-render` check goes red: the render has not landed yet.
2. Dispatch the branch render (`gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f branch=<branch>`), watch the run, and review the render commit that appears on the PR. `module-render` goes green; merge.
3. Finish the module's companion steps (labels, secrets, one-time setup, starter customization).

## When to Apply

- "Enable the fuzzer" / "add nightly CI" / "turn on pages" / "host skills in this repo" / "add the uv toolchain" on a repo that already carries `.repo-platform.yml`
- Outcome-shaped asks that map to a module: "add Python/Rust support to this repo" (uv/rust), "start cutting releases here" (release-please), "publish the docs as a website" (docs-site), "deploy the repo's own site build" (pages), "check PR titles" (pr-title), "what modules does this repo have" (read `.repo-platform.yml`)
- "Remove a module" / "drop the fuzzer" / "we do not need issue-templates anymore"
- "Change nightly_label" / "move the skills directory" / "change the pages build command" - module parameters, not selection

For enrolling a repo that is not managed yet, use the `repo-platform-new-project` skill instead. And inside repo-platform itself, "add a module" means authoring a new `templates/<module>/` folder (its CLAUDE.md covers that) - this skill is for managed repos.

## The module roster

One line each, generated from the module manifests (`templates/<module>/module.yml` in repo-platform), the same source as the `modules` question's `choices` in `copier.yml`.

| Module | What it gives the repo |
|---|---|<!-- BEGIN GENERATED: module-roster (scripts/generate.ts - edit module.yml manifests, not this block) -->
| `bun` | TypeScript/bun toolchain (gitignore, dependabot, CodeQL JS) |
| `node` | JavaScript/Node.js toolchain (gitignore, npm dependabot, CodeQL JS) |
| `deno` | Deno toolchain (deno fmt/lint, deno dependabot, CodeQL JS) |
| `uv` | Python/uv toolchain (gitignore, dependabot, CodeQL Python) |
| `rust` | Rust/cargo toolchain (cargo dependabot, Rust gitignore; no CodeQL) |
| `pages` | GitHub Pages deploy of the repo's own build (root = newest served version tag, /latest/ = main) |
| `docs-site` | VitePress docs site from docs/ under the central fleet theme (repos carry only markdown) |
| `release-please` | gate-downstream release job in ci.yml + autorelease labels |
| `issue-templates` | bug/feature issue forms |
| `skills` | agent skills hosting (plugin manifests, skill validation) |
| `pr-title` | Conventional Commit PR title check, its own required workflow |
| `fuzzer` | nightly fuzz starter with issue filing, replay inputs, auto-close |
| `nightly` | nightly CI starter with failure issue filing and auto-close |
| `custom-license` | repo carries its own license in LICENSE.md; the fleet license is not rendered |<!-- END GENERATED: module-roster -->

Per-module details - what is managed vs starter, parameters, companion steps, removal notes - are in [references/modules.md](references/modules.md).

## Adding a module

### 1. Edit the selection (and parameters) on a branch and open the PR

```bash
git checkout -b add-nightly
# .repo-platform.yml - add the module name to the top-level list:
modules: ["release-please", "issue-templates", "pr-title", "nightly"]
git commit -am "chore: select the nightly module"
gh pr create
```

The PR's `module-render` check (a fleet-ci job, pull requests only) renders the template for the new selection and compares the managed files against the PR tree. It goes RED at this point, naming the stale files and the exact dispatch line of step 2:

```text
::error file=.github/workflows/ci.yml::module-render: .github/workflows/ci.yml does not match the render of the selected modules
::error file=.github/.copier-answers.yml::module-render: .github/.copier-answers.yml does not match the render of the selected modules
::error::module-render: the module selection changed but its render has not landed on this branch; push it with: gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f branch=add-nightly
```

A typo is safe: a name the template does not know fails the render loudly instead of being dropped, and `validate-template` on the PR flags an unknown module name too. Two more caveats:

- A brand-new module reaches a repo only through a template ref that ships it: the `build` branch must be rebuilt from the main merge that added it (the post-green publish runs after every green main push). The render check judges the PR at its recorded `_commit`, so a module that build does not offer fails the render with copier's error; the step-2 dispatch renders from the build tip and heals it.
- If the module has a parameter and you do NOT want its default, record the answer in `.github/.copier-answers.yml` in the same PR (see "Module parameters" below). With no recorded answer, the render uses the default. A hand edit to the answers file also turns `validate-template` red (the file is managed, and its stamped hash no longer matches) until the step-2 render rewrites and restamps it.

Do not merge yet: the render is what step 2 pushes onto this PR.

### 2. Push the render onto the PR

```bash
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f branch=add-nightly
sleep 10
# The dispatch returns no run id: take the oldest sync-repos dispatch created since $since (yours,
# unless another operator dispatched in the same seconds; the run's log names its target).
run="$(gh run list -R Vivswan/repo-platform --workflow sync-repos.yml --event workflow_dispatch \
  --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$since\")] | last | .databaseId")"
gh run watch -R Vivswan/repo-platform "$run" --exit-status
```

The run is the ordinary sync against the branch (migration ladder, three-way `copier update`, split-file rebuild, retired-file cleanup, manifest stamp, validation); instead of a sync PR it pushes one commit onto `add-nightly` and comments on the PR with the sections a sync PR body carries. Expect, on the PR:

- a commit `chore: render the nightly module` (the module's managed files, `ci.yml`'s module list, the rewritten `.github/.copier-answers.yml`, the module's starters where absent), and `module-render` green on the new head;
- a comment from the sync listing carried local content, dropped conflict hunks, retired paths, or migration notes when the update produced any.

No commit after the run? Read the run before concluding nothing happened:

```bash
gh run list -R Vivswan/repo-platform --workflow sync-repos.yml
gh run view <id> -R Vivswan/repo-platform --log-failed   # a red run: the failed steps
gh run view <id> -R Vivswan/repo-platform --log          # a green run: every step, the notices included
```

- A cancelled run that never started: the `sync-repos` concurrency group cancels a dispatch when another sync run is already pending ("a higher priority waiting request exists"); dispatch again once that run finishes.
- A red plan job: the dispatch refuses `branch` without exactly one `repo` (a list, `all`, a visibility token, or an empty repo), and `branch` with `recover=recopy`.
- A red sync job before any render: the branch is the default branch (that flow is the sync PR), the branch does not exist on the repository, or the repository is not registered on that branch.
- A green run with no commit: the branch already carried the render; the Detect changes step's notice says "already matches".

That log is where a failed run explains itself for PUBLIC target repos - they get no failure issue. Only private (hidden-detail) targets receive a failure-report issue on the repo itself, because their details must stay out of the public log.

Merging first still works: the weekly cron (Tuesday 08:50 UTC) or a dispatch without `branch` (`gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo>`) delivers the render as an ordinary sync PR against the default branch. Until it lands, `module-render` has nothing to judge (it runs on PRs only), but a toolchain module's missing pin dotfile keeps `validate-template` red on every PR of the repo.

### 3. Review every changed file (mandatory)

The render commit is an ordinary sync delivery: before the PR merges, classify and clear every file it touched using the `repo-platform-sync-pr` skill's per-file review pass (it installs independently: [skills/repo-platform-sync-pr](https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-sync-pr)). The check specific to a module change: "does the modules diff explain this file?" - every addition should trace to the module you added.

What the render delivers, in two classes:

- Managed files: arrive now and keep updating on every future sync (workflow callers, ci.yml jobs, dependabot entries, gitignore sections). Do not edit them.
- Generated-once starters (`_skip_if_exists`): arrive once, then repo-owned - sync never touches them again. Modules that ship starters: `fuzzer` (`nightly-fuzz.yml`), `nightly` (`nightly.yml`), `skills` (`.claude-plugin/plugin.json` + `marketplace.json`), `release-please` (`update-release.yml`, `update-release-pr.yml`, `release-please-config.json`, `.release-please-manifest.json`), `issue-templates` (issue forms + chooser), and any formatter toolchain (bun/node/deno/uv, not rust: `auto-format.yml` gains that toolchain only if the file does not exist yet). A starter that already exists is never re-rendered - a repo adopting `skills` with existing manifests keeps them untouched.

### 4. Finish the companion steps

The full checklist per module is in [references/modules.md](references/modules.md). The ones that bite when skipped:

- Settings labels need no hand work in the managed repo; the module's labels live in repo-platform:
  - A module's fixed labels (the dependabot label for a new toolchain, the `autorelease: *` pair plus `release-blocker`/`release-override` for `release-please`) sit in its own `templates/<module>/settings.yml` layer, declared in its `module.yml` under `settings_layers` (the render selects layer files from that declaration, and the manifest loader refuses an undeclared or missing one); the merge picks them up at apply time.
  - The tracking labels of `fuzzer`/`nightly`/`docs-site` are per-repo answers, read from `.github/.copier-answers.yml` at the default branch; the assembly refuses to guess one.
  - The render commit records that answer, default or custom, so the step-2 flow merges selection and label together.
  - The merge-first fallback opens a window between the selection merge and the sync PR: record the answer in the selection PR to close it.
- `bun`: register a repo-scoped Contents:RW PAT as a DEPENDABOT secret so the lockfile fixer's push re-runs CI (human-only - needs the token value): `gh secret set REPO_PLATFORM_TOKEN --app dependabot`.
- `pages` / `docs-site`: the modules' settings layers enable Pages on the next fleet settings apply; only a deploy before that apply needs Settings -> Pages -> Source: GitHub Actions.
- `docs-site`, after the sync PR merges: create `docs/README.md` with a top-level link table of the reader's top tasks (it seeds the sidebar order and the search launcher's rows), check every link resolves inside `docs/` or is absolute, expect the first PR touching `docs/` to name each dead internal link, and add `order`/`group` frontmatter only where file order reads wrong. What the theme derives from the markdown and the repository: the `repo-platform-new-project` skill's step 5b, or repo-platform's [docs/docs-site.md](https://github.com/Vivswan/repo-platform/blob/main/docs/docs-site.md).
- `skills`: the starter manifests are repo-owned - a skill folder is unpublished until `plugin.json`'s `skills` array lists it.
- `fuzzer` / `nightly`: replace the starter's placeholder step with real work; until then it is a green no-op that never files issues.

## Module parameters

How the sync actually renders answers: it passes only `modules` (from `.repo-platform.yml`) and the live `private`/`description` as data. Every other answer - `nightly_label`, `fuzzer_label`, `docs_site_label`, `docs_site_path`, `skills_dir`, the `pages_*` set, `homepage`, `topics`, `copyright_holder` - is loaded from the repo's recorded `.github/.copier-answers.yml`, and a question with no recorded answer (a module just added) takes its `copier.yml` default.

So the parameter mechanism is the recorded answers file, edited by PR on the default branch:

```bash
# Same PR as the modules edit (or its own PR later):
# .github/.copier-answers.yml - add or change the VALUE key:
#   nightly_label: slow-suite-failure
git checkout -b add-nightly
# edit .repo-platform.yml (modules) and .github/.copier-answers.yml (answer)
git commit -am "chore: add the nightly module with a custom label"
gh pr create
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f branch=add-nightly
# the render commit lands on the PR; review it, then merge
```

The `module-render` check treats an answers-file edit like a selection edit: the PR is red until the render lands, then green.

The answers file holds three classes of key - know which one you are touching:

- `_`-prefixed keys (`_commit`, `_src_path`): never touch them, and never delete the file - `copier update` depends on them, and a broken `_commit` puts the repo on the recovery path.
- `modules`, `private`, `description`: recorded here, but force-overridden by the sync every run - an edit here silently evaporates. Change them at their real source: `.repo-platform.yml` for modules, and the repo's own `.github/settings.yml` for visibility and description (the settings apply enforces that file; the sync then adopts the applied values).
- Everything else (the module parameters above): editing the value key here IS the mechanism. The render (the branch dispatch, or the next sync) re-renders everything derived from the answer and rewrites `.github/.copier-answers.yml` itself consistently; an answer that violates its copier validator fails the run loudly. The settings assembly reads tracking labels from exactly this file on the default branch, so the recorded value is what the apply declares.

When several tracking-stream modules are selected (`fuzzer`, `nightly`, `docs-site`), their labels must pairwise differ (case-insensitively - GitHub deduplicates label names that way): every stream dedups AND auto-closes by label, so a shared label lets one stream's green night close another's open issue. The copier validators and the settings assembly both reject the collision.

One ripple to remember: renaming a fuzz or nightly tracking label never updates the repo-owned starter workflow - update the starter's two `label:` inputs in the same PR, or it keeps filing under the old name while the settings apply deletes that label. The managed baseline picks the renamed value up automatically on the next apply (it reads the recorded answer), and `docs_site_label` needs no second edit at all: its workflow is managed, so the next sync PR re-renders the input.

## Removing a module

Deselecting works the same way: remove the name from `modules:` in `.repo-platform.yml` on a branch, open the PR, and dispatch the branch render (the commit is `chore: remove the <module> module render`); merging first and taking the next sync PR works too. What actually happens:

- Managed files the module owned leave the render and are deleted - including locally modified ones (the retired-file cleanup diffs two clean renders; every removal is listed in the PR comment, or the sync PR body, for review). Check none were repurposed locally before merging.
- Starters and repo-owned files stay: `_skip_if_exists` files are never deleted by sync. Dropping `fuzzer`/`nightly` leaves `nightly-fuzz.yml`/`nightly.yml` running - delete the workflow yourself, or keep its tracking label declared in your settings.
- `.github/settings.yml` is never deleted by sync; repository settings stay managed for every repo with a `.repo-platform.yml` (docs/settings.md).
- Dropping `custom-license` is guarded: the sync FAILS with instructions while the repo's own license file still exists, because the incoming fleet LICENSE.md cannot be reconciled with it. Delete the old license in the same commit that removes the module (git history records prior licensing; third-party notices go below the fleet LICENSE.md's END marker), then re-run the sync.
- Label cleanup is automatic: the baseline stops declaring the dropped module's labels and the next apply deletes them from the repo. If you kept the module's starter workflow running, declare its tracking label in the repo's own `.github/settings.yml` first, or the apply strips the label off the open tracking issue.

A module the TEMPLATE retired or folded into its base (`agents`, `auto-assign`, and `settings-sync` were folded into the base; the settings-sync workflow was later retired outright, leaving the `.github/settings.yml` starter) is handled by a migration rung: the sync rewrites `.repo-platform.yml` to drop the name before selecting modules and says so in the PR body (repo-platform's docs/migrations.md); a hand edit is only needed when the rung's note asks for one.

## Verify

- The dispatch run is green, `module-render` is green on the PR's new head, and the render commit's diff is fully explained by the modules diff (step 3 above).
- After merging: any managed CI jobs the module adds (CodeQL for a toolchain on a public repo, `release-freshness`/`release-health` for release-please, `validate-skills` for skills) appear in the repo's `all-green` gate on the next PR - many modules add no gated job at all (pr-title's check is its own required workflow, outside the gate) - and starters exist and are ready to fill in.
- For label-carrying modules: the next settings apply is green (`gh workflow run settings-repos.yml -R Vivswan/repo-platform -f check_only=true -f repo=Vivswan/<repo>` for a dry run).

Two end-to-end walkthroughs - adding `nightly` to a repo that already has `fuzzer`, and adding `skills` - are in [references/worked-examples.md](references/worked-examples.md).
