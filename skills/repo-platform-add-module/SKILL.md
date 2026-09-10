---
name: repo-platform-add-module
description: 'Add or remove a Vivswan/repo-platform module in a managed repository - edit the modules list in .repo-platform.yml, merge it, run the sync for the module files, and finish the companion steps. Use when someone says "add a module", "enable the fuzzer", "add nightly CI to this repo", "turn on pages", "host skills in this repo", "add the bun toolchain", "add Python support to this repo", "add Rust support", "start cutting releases here", "publish the docs site", "check PR titles on this repo", "remove a module", "drop the fuzzer", "disable nightly", asks "what modules does this repo have", or asks how to change a module setting like the nightly label, the fuzzer label, the skills directory, or the pages build command.'
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: Adding or Removing a Module

Module selection is the top-level `modules:` list in the repository's own `.repo-platform.yml`. The sync reads it and writes the files each selected module brings; `ci.yml` is the same file in every repository and never changes with the selection. No edit in repo-platform is needed.

Work in this order, always:

1. Edit `modules:` (and the module's keys) in `.repo-platform.yml` on a branch and merge the PR.
2. Run the sync: `gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f manual=true`. Review the sync PR's report and merge.
3. Finish the module's companion steps (starter customization, secrets, one-time setup).

## When to Apply

- "Enable the fuzzer" / "add nightly CI" / "turn on pages" / "host skills in this repo" / "add the uv toolchain" on a repo that already carries `.repo-platform.yml`
- Outcome-shaped asks that map to a module: "add Python/Rust support" (uv/rust), "start cutting releases" (release-please), "publish the docs as a website" (docs-site), "deploy the repo's own site build" (pages), "check PR titles" (pr-title), "what modules does this repo have" (read `.repo-platform.yml`)
- "Remove a module" / "drop the fuzzer" / "we do not need pr-title anymore"
- "Change the nightly label" / "move the skills directory" / "change the pages build command": module keys, not selection

For enrolling a repo that is not managed yet, use the `repo-platform-new-project` skill instead. Inside repo-platform itself, "add a module" means adding a `files/<module>/` folder and its `files.yml` entries; this skill is for managed repos.

## The module roster

One line each, generated from the module manifests.

| Module | What it gives the repo |
|---|---|<!-- BEGIN GENERATED: module-roster (scripts/generate.ts - edit module.yml manifests, not this block) -->
| `bun` | TypeScript/bun toolchain (gitignore, dependabot, CodeQL JS) |
| `node` | JavaScript/Node.js toolchain (gitignore, npm dependabot, CodeQL JS) |
| `deno` | Deno toolchain (deno fmt/lint, deno dependabot, CodeQL JS) |
| `uv` | Python/uv toolchain (gitignore, dependabot, CodeQL Python) |
| `rust` | Rust/cargo toolchain (cargo dependabot, Rust gitignore; no CodeQL) |
| `pages` | GitHub Pages deploy of the repo's own build (root = newest served version tag, /latest/ = main) |
| `docs-site` | VitePress docs site from docs/ under the central fleet theme (repos carry only markdown) |
| `release-please` | release-please releases through the fleet's release pipeline, plus autorelease labels |
| `issue-templates` | bug/feature issue forms |
| `skills` | agent skills hosting (plugin manifests, skill validation) |
| `pr-title` | Conventional Commit PR title check, its own required workflow |
| `fuzzer` | nightly fuzz starter with issue filing, replay inputs, auto-close |
| `nightly` | nightly CI starter with failure issue filing and auto-close |
| `custom-license` | repo carries its own license in LICENSE.md; the fleet license is not rendered |<!-- END GENERATED: module-roster -->

## What each module writes

From repo-platform's `files.yml` (`bun scripts/files_table.ts` prints the live table). Managed files are rewritten on every sync; starters are written once and then repo-owned; split files get the module's block inside their managed region.

| Module | Files | Class |
|---|---|---|
| `bun` | `.bun-version`, `.github/workflows/dependabot-bun-lockfile.yml` | managed |
| `node` | `.node-version` | managed |
| `deno` | `.dvmrc`, `.github/workflows/deno-audit.yml` | managed |
| `uv`, `rust` | no file of their own | - |
| every toolchain | blocks in `.gitignore`, `.github/dependabot.yml`, and `AGENTS.md` | split |
| every toolchain but `rust` | `.github/workflows/auto-format.yml`; the CodeQL variant of `auto-assign.yml` on public repos | starter; managed |
| `pages` | `.github/workflows/pages.yml` | managed |
| `docs-site` | `.github/workflows/docs-site.yml` | managed |
| `release-please` | `release-please-config.json`, `.release-please-manifest.json`; the release variant of `.typography-allow` | starter; managed |
| `issue-templates` | nothing: the forms are served by the account's `.github` repository | - |
| `skills` | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`; `.github/workflows/validate-skills.yml` | starter; managed |
| `pr-title` | `.github/workflows/pr-title.yml` | managed |
| `fuzzer` | `.github/workflows/nightly-fuzz.yml` | starter |
| `nightly` | `.github/workflows/nightly.yml` | starter |
| `custom-license` | `LICENSE.md` is no longer written; the fleet copy is retired on that sync | - |

The release, pages, and docs-site legs of `ci.yml` exist in every repository and run only when their module is selected. Per-module keys, companion steps, and removal notes are in [references/modules.md](references/modules.md).

## Adding a module

### 1. Edit the registration and merge

```bash
git checkout -b add-nightly
# .repo-platform.yml: add the name to the top-level list
#   modules: [release-please, issue-templates, pr-title, nightly]
# and the module's keys only when the defaults are wrong:
#   labels:
#     nightly: slow-suite-failure
git commit -am "chore: select the nightly module"
gh pr create
```

The `plan` job of fleet CI parses `.repo-platform.yml` on the PR: an unknown key, a wrong shape, a duplicate module name, a module name the platform does not offer, or a `labels.*` key whose module is not selected fails there. Merge when green.

One exception to "registration first": selecting `skills` turns on the `validate-skills` gate job on that same PR, and the job reads `.claude-plugin/plugin.json`. Commit a minimal manifest in the PR (the sync reports it `unchanged` afterwards) or the gate stays red until the sync PR lands:

```json
{ "name": "<slug>-skills", "description": "Agent skills for <name>", "skills": [] }
```

### 2. Run the sync and review its PR

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f manual=true
gh run list -R Vivswan/repo-platform --workflow sync-repos.yml --limit 1
gh run watch -R Vivswan/repo-platform <id> --exit-status
```

The run summary reads `plan: 1 rows` and then `row 1: PR opened` (or `PR refreshed` when a sync PR was already open). The sync PR's report should be explained by the module diff:

- Written: the module's files as `created`; a starter the repo already had reads `unchanged`; every other row `unchanged` or `updated`.
- Split files: the diff stays inside the `BEGIN/END REPO-PLATFORM MANAGED` markers.
- Retired: empty, except for `custom-license`, which retires the fleet `LICENSE.md` (below).
- Review: `Hold for review: no` on a clean add; `manual=true` keeps it waiting for you anyway.

Anything the module diff does not explain is reviewed with the `repo-platform-sync-pr` skill before merging.

`row 1: unchanged` with no PR means the repo already holds every file of the new selection. `failed, report filed in the target repository` means the `[repo-platform] sync failed` issue in the repo has the error. The weekly sync delivers the same files if you do not dispatch.

### 3. Finish the companion steps

The full checklist per module is in [references/modules.md](references/modules.md). The ones that bite when skipped:

- Labels: the settings apply declares each module's default label, but it still reads the tracking labels of `fuzzer`, `nightly`, and `docs-site` from the retired `.github/.copier-answers.yml` and fails for a repo that selects one of them without that file. Declare the module's label (default or custom) in the repo's own `.github/settings.yml`; a custom `labels.*` value is never read by the apply.
- `fuzzer` / `nightly`: replace the starter's placeholder step with real work; a custom label also goes into the starter's `label:` inputs.
- `skills`: a skill folder is unpublished until `plugin.json`'s `skills` array lists it.
- `bun`: register a repo-scoped Contents:RW PAT as a Dependabot secret so the lockfile fixer's push re-runs CI: `gh secret set REPO_PLATFORM_TOKEN --app dependabot`.
- `pages` / `docs-site`: enable Pages with Source: GitHub Actions before the first deploy (`gh api -X POST repos/Vivswan/<repo>/pages -f build_type=workflow`); `docs-site` also needs `docs/README.md` to exist.

## Module keys

A module's settings live next to the selection, in `.repo-platform.yml`, and are changed by an ordinary PR:

| Module | Keys | Default |
|---|---|---|
| `pages` | `pages.setup`, `pages.install`, `pages.build`, `pages.dist` | the selected toolchains; the commands of the first `pages.setup` toolchain in roster order; `dist` |
| `docs-site` | `docs_site.path`, `docs_site.include`, `labels.docs_site` | `docs`, none, `docs-link-rot` |
| `skills` | `skills.dir` | `skills` |
| `fuzzer` | `labels.fuzzer` | `fuzz-nightly` |
| `nightly` | `labels.nightly` | `nightly-failure` |
| any | `project` (`name`, `slug`, `description` together; `copyright_holder` optional), `mirrors` | the repository name, the name, empty, the owner; none |

- A key change alone needs no sync: the pages and docs-site legs read the registration at run time. `mirrors` and `project.*` land with the next sync: `project.*` values are substituted into every managed file and split region (`AGENTS.md`, `LICENSE.md`), while an existing starter (`.github/settings.yml`, the plugin manifests) keeps its content, so edit it yourself.
- Tracking labels (`fuzzer`, `nightly`, `docs_site`) must pairwise differ, case-insensitively: every stream dedups and auto-closes by label. A `labels.*` key whose module is not selected fails the plan, and so does a value that disagrees with a surviving `.github/.copier-answers.yml` (the two must agree while both files exist).
- Renaming a fuzz or nightly label never updates the repo-owned starter: change its two `label:` inputs in the same PR.

## Removing a module

Remove the name from `modules:` and the module's own keys (`labels.<key>`, `pages`, `docs_site`, `skills`), merge, run the sync. What the report shows:

- Retired: the module's managed and split files. `deleted` with the detail `no longer selected` when the file still held the platform's own content; `held` with the reason when someone edited it or a split file carries a repo-owned tail (decide, then delete or keep it yourself).
- Starters stay: the sync never deletes a repo-owned file. Dropping `fuzzer` or `nightly` leaves its workflow running; delete it yourself or keep its label declared in `.github/settings.yml`.
- Labels: the module's labels leave the settings baseline and the next apply removes them from the repo.
- Adding `custom-license`: the fleet `LICENSE.md` is retired on that sync, `deleted` when untouched and `held` when you had written outside its region. Commit the repo's own `LICENSE.md` after that PR merges. Removing it: the fleet license region is written above whatever `LICENSE.md` holds (a split file without markers gets the region above its content); delete the old text in the sync PR.

## Verify

- The sync run ends `row 1: PR opened` and every Written row is explained by the module diff.
- After merging, the module's leg or job runs on the next push to main (`release` for release-please, `pages`, `docs-site`; `validate-skills` inside the `ci` job for skills). Many modules add no job at all.
- For label-carrying modules, the label exists on the repo after the next settings apply: `gh label list -R Vivswan/<repo>`.

Two end-to-end walkthroughs, adding `nightly` to a repo that already has `fuzzer` and adding `skills`, are in [references/worked-examples.md](references/worked-examples.md).
