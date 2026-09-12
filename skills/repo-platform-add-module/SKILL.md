---
name: repo-platform-add-module
description: 'Add or remove a Vivswan/repo-platform module in a managed repository - edit the modules list in .repo-platform.yml, merge it, run the sync for the module files, and finish the companion steps. Use when someone says "add a module", "enable the fuzzer", "add nightly CI to this repo", "publish a site", "add the bun toolchain", "add Python support to this repo", "add Rust support", "start cutting releases here", "publish the docs site", "check PR titles on this repo", "remove a module", "drop the fuzzer", "disable nightly", asks "what modules does this repo have", or asks how to change a module setting like the nightly label, the fuzzer label, or the docs mount path.'
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: Adding or Removing a Module

Module selection is the top-level `modules:` list in the repository's own `.repo-platform.yml`. The sync reads it and writes the files each selected module brings; `ci.yml` is the same file in every repository and never changes with the selection. No edit in the platform repository is needed.

Work in this order, always:

1. Edit `modules:` (and the module's keys) in `.repo-platform.yml` on a branch and merge the PR.
2. Run the sync: `gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f manual=true`. Review the sync PR's report and merge.
3. Finish the module's companion steps (starter customization, secrets, one-time setup).

## When to Apply

- "Enable the fuzzer" / "add nightly CI" / "publish a site" / "add the uv toolchain" on a repo that already carries `.repo-platform.yml`
- Outcome-shaped asks that map to a module: "add Python/Rust support" (uv/rust), "start cutting releases" (release-please), "publish the docs as a website" / "deploy the repo's own website" (site), "check PR titles" (pr-title), "what modules does this repo have" (read `.repo-platform.yml`)
- "Remove a module" / "drop the fuzzer" / "we do not need pr-title anymore"
- "Change the nightly label" / "mount the docs under another path": module keys, not selection. The site build itself is the repo-owned `.github/actions/site-build/action.yml` hook, edited like any file of the repo

For enrolling a repo that is not managed yet, use the `repo-platform-new-project` skill instead. Inside the platform repository itself, "add a module" means adding a `files/<module>/` folder and its `files.yml` entries; this skill is for managed repos.

## The module roster

One line each, the `description` of each module in the platform's `files.yml`.

| Module | What it gives the repo |
|---|---|
| `bun` | TypeScript/bun toolchain (gitignore, dependabot, CodeQL JS) |
| `deno` | Deno toolchain (deno fmt/lint, deno dependabot, CodeQL JS) |
| `uv` | Python/uv toolchain (gitignore, dependabot, CodeQL Python) |
| `rust` | Rust/cargo toolchain (cargo dependabot, Rust gitignore; no CodeQL) |
| `site` | one GitHub Pages site per repository (the repo-owned site-build hook's website at the root, docs/ rendered under the central fleet theme) |
| `release-please` | release-please releases through the fleet's release pipeline, plus autorelease labels |
| `pr-title` | Conventional Commit PR title check, its own required workflow |
| `fuzzer` | nightly fuzz starter with issue filing, replay inputs, auto-close |
| `nightly` | nightly CI starter with failure issue filing and auto-close |
| `custom-license` | repo carries its own license in LICENSE.md; the fleet license is not written |

## What each module writes

From the platform's `files.yml` (`bun scripts/files_table.ts` prints the live table). Managed files are rewritten on every sync; starters are written once and then repo-owned; split files get the module's block inside their managed region.

| Module | Files | Class |
|---|---|---|
| `bun` | `.bun-version` | managed |
| `deno` | `.dvmrc`, `.github/workflows/deno-audit.yml` | managed |
| `uv`, `rust` | no file of their own | - |
| every toolchain | blocks in `.gitignore` and `AGENTS.md`; a block in `.github/dependabot.yml` | split; managed |
| every toolchain but `rust` | `.github/workflows/auto-format.yml`; the CodeQL variant of `auto-assign.yml` on public repos | starter; managed |
| `site` | no file of its own: the `.github/actions/site-build/action.yml` hook is a base starter every repository carries | - |
| `release-please` | `release-please-config.json`, `.release-please-manifest.json`; the release variant of `.typography-allow` | starter; managed |
| `pr-title` | `.github/workflows/pr-title.yml` | managed |
| `fuzzer` | `.github/workflows/nightly-fuzz.yml` | starter |
| `nightly` | `.github/workflows/nightly.yml` | starter |
| `custom-license` | `LICENSE.md` is no longer written; the fleet copy is retired on that sync | - |

The release and site legs of `ci.yml` exist in every repository and run only when their module is selected. Per-module keys, companion steps, and removal notes are in [references/modules.md](references/modules.md).

## Adding a module

### 1. Edit the registration and merge

```bash
git checkout -b add-nightly
# .repo-platform.yml: add the name to the top-level list
#   modules: [release-please, pr-title, nightly]
# and the module's keys only when the defaults are wrong:
#   labels:
#     nightly: slow-suite-failure
git commit -am "chore: select the nightly module"
gh pr create
```

The `plan` job of fleet CI parses `.repo-platform.yml` on the PR: an unknown key, a wrong shape, a duplicate module name, a module name the platform does not offer, or a `labels.*` key whose module is not selected fails there. Merge when green.

One exception to "registration first", where a gate job the selection turns on reads a file of yours on that same PR: `site` on a repo with a `docs/` directory. The `docs-check` job builds `docs/` strictly and needs `docs/README.md` (the landing page). Add it in the same PR, or the PR is red. A repo whose own website renders `docs/` sets `site.path: null` instead: the website publishes alone and `docs-check` stands down.

### 2. Run the sync and review its PR

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f manual=true
gh run list -R Vivswan/repo-platform --workflow sync-repos.yml --limit 1
gh run watch -R Vivswan/repo-platform <id> --exit-status
```

The run's job log (`gh run view <id> --log`) reads `plan: 1 rows` and then `row 0: PR opened` (rows are numbered from 0; `PR refreshed` when a sync PR was already open). The sync PR's report should be explained by the module diff:

- Written: the module's files as `created`; a starter the repo already had reads `unchanged`; `.github/settings.yml` as `managed`, `updated` when the module changes the render (a label or ruleset no other selected module already declares, a tracking label); every other row `unchanged` or `updated`.
- Split files: the diff stays inside the `BEGIN/END REPO-PLATFORM MANAGED` markers.
- Retired: empty, except for `custom-license`, which retires the fleet `LICENSE.md` (below).
- Review: `Hold for review: no` on a clean add; `manual=true` keeps it waiting for you anyway.

Anything the module diff does not explain is reviewed with the `repo-platform-sync-pr` skill before merging.

`row 0: unchanged` with no PR means the repo already holds every file of the new selection. `failed, report filed in the target repository` means the `[repo-platform] sync failed` issue in the repo has the error. Without a dispatch, the Tuesday cron delivers the files on its own.

### 3. Finish the companion steps

The full checklist per module is in [references/modules.md](references/modules.md). The ones that bite when skipped:

- Labels: the sync renders the tracking labels of `fuzzer`, `nightly`, and `site` from the registration's `labels.*` keys (the module's default when the key is unset) into the managed `.github/settings.yml`, and the settings apply declares them; a `labels.*` key for a module the repo does not select fails the plan and holds the sync PR.
- `fuzzer` / `nightly`: replace the starter's placeholder step with real work; a custom label also goes into the starter's `label:` inputs.
- `site`: the module's settings layer enables Pages on the next settings apply (before it: `gh api -X POST repos/Vivswan/<repo>/pages -f build_type=workflow`); the repo's own website goes into the repo-owned `.github/actions/site-build/action.yml` hook, seeded as a no-op, so fill it in or the site is the docs alone (`docs/README.md` was step 1's business).

## Module keys

A module's settings live next to the selection, in `.repo-platform.yml`, and are changed by an ordinary PR:

| Module | Keys | Default |
|---|---|---|
| `site` | `site.path`, `site.include`, `labels.site` | `docs`, none, `docs-link-rot` |
| `fuzzer` | `labels.fuzzer` | `fuzz-nightly` |
| `nightly` | `labels.nightly` | `nightly-failure` |
| any | `project` (required: `name`, `slug`, `description` together; `copyright_holder` optional), `mirrors` | none (`copyright_holder`: the owner); none |

- A key change alone needs no sync: the site leg reads the registration at run time. `mirrors`, `labels.*`, and `project.*` land with the next sync: `project.*` values are substituted into every managed file and split region (`AGENTS.md`, `LICENSE.md`), a `labels.*` value is rendered into `.github/settings.yml`, while an existing starter (`.github/settings.local.yml`) keeps its content, so edit it yourself.
- Tracking labels (`fuzzer`, `nightly`, `site`) must pairwise differ, case-insensitively: every stream dedups and auto-closes by label. A `labels.*` key whose module is not selected fails the plan.
- Renaming a fuzz or nightly label never updates the repo-owned starter: change its two `label:` inputs in the same PR.

## Removing a module

Remove the name from `modules:` and the module's own keys (`labels.<key>`, `site`), merge, run the sync. What the report shows:

- Retired: the module's managed and split files. `deleted` with the detail `no longer selected` when the file still held the platform's own content; `region removed` when a split file's region was untouched but the repo had written around it (the region and its markers go, your content stays as a plain file); `held` with the reason when someone edited the content (decide, then delete or keep it yourself).
- Starters stay: the sync never deletes a repo-owned file. Dropping `fuzzer` or `nightly` leaves its workflow running; delete it yourself or keep its label declared in `.github/settings.local.yml`.
- Labels: the module's labels leave the rendered `.github/settings.yml` on that sync (`managed`, `updated`) and the next apply removes them from the repo, unless another selected module still declares them or your `.github/settings.local.yml` does: a label still declared stays rendered and applied.
- Adding `custom-license`: the fleet `LICENSE.md` is retired on that sync, `deleted` when untouched, `region removed` when you had written outside its region (your text stays as a plain file), and `held` when the region itself was edited. Commit the repo's own `LICENSE.md` after that PR merges. Removing it: the fleet license region is written above whatever `LICENSE.md` holds (a split file without markers gets the region above its content, reported `region added`, which holds the PR); delete the old text in the sync PR.

## Verify

- The sync run's job log ends `row 0: PR opened` and every Written row is explained by the module diff.
- After merging, the module's leg or job runs on the next push to main (`release` for release-please, `site`). Many modules add no job at all.
- For label-carrying modules, the label exists on the repo after the next settings apply once the sync PR has merged: `gh label list -R Vivswan/<repo>`.

An end-to-end walkthrough, adding `nightly` to a repo that already has `fuzzer`, is in [references/worked-examples.md](references/worked-examples.md).
