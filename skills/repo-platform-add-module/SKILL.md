---
name: repo-platform-add-module
description: 'Add or remove a Vivswan/repo-platform module in a managed repository - edit the modules list in .repo-platform.yml, bring the module files onto the PR with a branch sync (or dispatch add_modules), merge it, and finish the companion steps. Use when someone says "add a module", "enable the fuzzer", "add nightly CI to this repo", "publish a site", "add the bun toolchain", "add Python support to this repo", "add Rust support", "start cutting releases here", "publish the docs site", "check PR titles on this repo", "remove a module", "drop the fuzzer", "disable nightly", asks "what modules does this repo have", or asks how to change a module setting like the nightly label, the fuzzer label, or the docs mount path.'
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: Adding or Removing a Module

Module selection is the top-level `modules:` list in the repository's own `.repo-platform.yml`. The sync reads it and writes the files each selected module brings; `ci.yml` is the same file in every repository and never changes with the selection. No edit in the platform repository is needed.

Work in this order, always:

1. Edit `modules:` (and the module's keys) in `.repo-platform.yml` on a branch and open the PR; it stays red until a branch sync writes the module's files onto it. Or dispatch the sync with `add_modules`, which opens a sync PR carrying the edit and the files.
2. Review the report (the sync PR's body, or the branch sync's comment) and merge.
3. Finish the module's companion steps (starter customization, one-time setup).

## When to apply

- "Enable the fuzzer" / "add nightly CI" / "publish a site" / "add the uv toolchain" on a repo that already carries `.repo-platform.yml`
- Outcome-shaped asks that map to a module: "add Python/Rust support" (uv/rust), "start cutting releases" (release-please), "publish the docs as a website" / "deploy the repo's own website" (site), "check PR titles" (pr-title), "what modules does this repo have" (read `.repo-platform.yml`)
- "Remove a module" / "drop the fuzzer" / "we do not need pr-title anymore"
- "Change the nightly label" / "mount the docs under another path": module keys, not selection. The site build itself is the repo-owned site-build hook (step 3), edited like any file of the repo

For enrolling a repo that is not managed yet, use the `repo-platform-new-project` skill instead. Inside the platform repository itself, "add a module" means adding a `files/<module>/` folder and its `files.yml` entries; this skill is for managed repos.

## The module roster

One line each, the `description` of each module in the platform's `files.yml`.

| Module | What it gives the repo |
|---|---|
| `bun` | TypeScript/bun toolchain (gitignore, dependabot, CodeQL JS) |
| `uv` | Python/uv toolchain (gitignore, dependabot, CodeQL Python) |
| `rust` | Rust/cargo toolchain (cargo dependabot, Rust gitignore; no CodeQL) |
| `site` | one GitHub Pages site per repository (the repo-owned site-build hook's website at the root, docs/ rendered under the central fleet theme) |
| `release-please` | release-please releases through the fleet's release pipeline, plus autorelease labels |
| `pr-title` | Conventional Commit PR title check, its own required workflow |
| `fuzzer` | nightly fuzz starter with issue filing, replay inputs, auto-close |
| `nightly` | nightly CI starter with failure issue filing and auto-close |
| `custom-license` | repo carries its own license in LICENSE.md; the fleet license is not written |

## What each module writes

From the platform's `files.yml`. Managed files are rewritten on every sync; starters are written once and then repo-owned; split files get the module's block inside their managed region.

| Module | Files | Class |
|---|---|---|
| `bun` | `.bun-version` | managed |
| `uv`, `rust` | no file of their own | - |
| every toolchain | blocks in `.gitignore` and `AGENTS.md`; a block in `.github/dependabot.yml` | split; managed |
| every toolchain but `rust` | `.github/workflows/auto-format.yml` | starter |
| `site` | no file of its own: the `.github/actions/site-build/action.yml` hook is a base starter every repository carries | - |
| `release-please` | `release-please-config.json`, `.release-please-manifest.json`; the release variant of `.typography-allow` | starter; managed |
| `pr-title` | `.github/workflows/pr-title.yml` | managed |
| `fuzzer` | `.github/workflows/nightly-fuzz.yml` | starter |
| `nightly` | `.github/workflows/nightly.yml` | starter |
| `custom-license` | `LICENSE.md` is no longer written; the fleet copy is retired on that sync | - |

The release and site legs of `ci.yml` exist in every repository and run only when their module is selected. Per-module keys, companion steps, and removal notes are in [references/modules.md](references/modules.md).

## Adding a module

### 1. Edit the registration and bring the files onto the PR

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

The `plan` step of fleet CI parses `.repo-platform.yml` on the PR: an unknown key, a wrong shape, a duplicate module name, a module name the platform does not offer, or a `labels.*` key whose module is not selected fails there.

The PR then stays red on `validate-managed-files` until a sync writes the module's files onto its branch: the check runs the writer over the tree with the edited registration and names each missing file with its bytes. Three ways bring them:

| Way | How | What it does |
| --- | --- | --- |
| the `add_modules` dispatch | `gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f add_modules=<a>,<b>` | no PR of your own: the sync PR carries the registration edit and the files, and waits for review |
| the branch dispatch | `gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f branch=<pr-branch>` | one commit onto your PR branch; the row prints `branch pushed` |
| the `repo-platform:sync` label | add the label to the PR | the repository's own token syncs the branch and comments the report, for a hold-free report only: it refuses, pushing nothing, when the sync touches `.github/workflows/` (so a module that brings a workflow, `fuzzer`, `nightly`, `pr-title`, takes the branch dispatch) or when the writer holds (a replaced local edit, a registration note) |

After a label sync, approve the pushed head's held run from the merge box (or push a commit): GitHub holds the run a repository-token push creates. The branch dispatch pushes with the fleet PAT, so its run starts on its own. Merge when green.

One exception to "registration first" is `site` on a repo with a `docs/` directory: a gate job the selection turns on reads a file of yours on that same PR. The `docs-check` job builds `docs/` strictly and needs `docs/README.md` (the landing page). Add it in the same PR, or the PR is red.

A repo whose own website renders `docs/` sets `site.path: null` instead: the website publishes alone and `docs-check` stands down.

### 2. Review the report

For a dispatch, the run's job log (`gh run view <id> --log`; `gh run list -R Vivswan/repo-platform --workflow sync-repos.yml --limit 1` finds the id) reads `plan: 1 rows` and then one row line, rows numbered from 0:

| Line | Meaning |
| --- | --- |
| `row 0: PR opened` | the sync PR is there (`PR refreshed` when one was already open); an `add_modules` run never arms it |
| `row 0: branch pushed` | the branch dispatch's clean row: one commit on your PR branch |
| `row 0: unchanged`, no PR | the repo already holds every file of the new selection |
| `failed, report filed in the target repository` | the `[repo-platform] sync failed` issue in the repo has the error |

The report (the sync PR's body, the branch sync's label comment, or a public repository's job summary on a branch dispatch) should be explained by the module diff:

- Written: the module's files as `created`; a starter the repo already had reads `unchanged`; `.github/settings.yml` as `managed`, `updated` when the module changes the render (a label or ruleset no other selected module already declares, a tracking label); every other row `unchanged` or `updated`.
- Split files: the diff stays inside the `BEGIN/END REPO-PLATFORM MANAGED` markers.
- Retired: empty, except for `custom-license`, which retires the fleet `LICENSE.md` (below).
- Review: `Hold for review: no` on a clean add; an `add_modules` sync PR waits for you anyway.

Anything the module diff does not explain is reviewed with the `repo-platform-sync-pr` skill before merging.

### 3. Finish the companion steps

The full checklist per module is in [references/modules.md](references/modules.md). The ones that bite when skipped:

- Labels: the sync renders the tracking labels of `fuzzer`, `nightly`, and `site` from the registration's `labels.*` keys (the module's default when the key is unset) into the managed `.github/settings.yml`, and the settings apply declares them; a `labels.*` key for an unselected module fails the plan (step 1) and also holds the sync PR.
- `fuzzer` / `nightly`: replace the starter's placeholder step with real work; a custom label also goes into the starter's `label:` inputs.
- `site`: the module's settings layer enables Pages on the next settings apply (before it: `gh api -X POST repos/Vivswan/<repo>/pages -f build_type=workflow`); the repo's own website goes into the repo-owned `.github/actions/site-build/action.yml` hook, seeded as a no-op, so fill it in or the site is the docs alone (`docs/README.md` was step 1's business).

## Module keys

A module's settings live next to the selection, in `.repo-platform.yml`, and are changed by an ordinary PR:

| Module | Keys | Default |
|---|---|---|
| `site` | `site.path`, `site.include`, `labels.site` | `docs`, none, `docs-link-rot` |
| `fuzzer` | `labels.fuzzer` | `fuzz-nightly` |
| `nightly` | `labels.nightly` | `nightly-failure` |

Two keys belong to no module. `project` is required, with `name`, `slug`, and `description` together; `copyright_holder` is optional and defaults to the owner. `mirrors` defaults to none.

- **No sync needed:** a `site.path` or `site.include` change; the site leg reads the registration at run time.
- **Needs a branch sync on the PR:** `mirrors`, `labels.*`, and `project.*`. The `repo-platform:sync` label pushes a hold-free report; a held one (a replaced local edit, or a mirror change that leaves a registration note, such as a dropped declaration whose recorded copy stays) takes the branch dispatch (`-f branch=`). `project.*` values are substituted into every managed file and split region (`AGENTS.md`, `LICENSE.md`); a `labels.*` value re-renders `.github/settings.yml` (step 3, Labels).
- **Starters keep their content:** an existing starter (`.github/settings.local.yml`) is not rewritten, so edit it yourself.
- Tracking labels (`fuzzer`, `nightly`, `site`) must pairwise differ, case-insensitively: every stream dedups and auto-closes by label.
- Renaming a fuzz or nightly label never updates the repo-owned starter: change its two `label:` inputs in the same PR.

## Removing a module

Remove the name from `modules:` and the module's own keys (`labels.<key>`, `site`) on a branch, bring the retirement onto the PR with a branch sync (step 1's branch dispatch; the label only when the report holds nothing and retires no workflow file, which dropping `pr-title` does; `add_modules` only adds), and merge. What the report shows:

- Retired: the module's managed and split files. `deleted` with the detail `no longer selected` when the file still held the platform's own content; `region removed` when a split file's region was untouched but the repo had written around it (the region and its markers go, your content stays as a plain file); `held` with the reason when someone edited the content (decide, then delete or keep it yourself).
- Starters stay: the sync never deletes a repo-owned file. Dropping `fuzzer` or `nightly` leaves its workflow running; delete it yourself or keep its label declared in `.github/settings.local.yml`.
- Labels: the module's labels leave the rendered `.github/settings.yml` on that sync (`managed`, `updated`) and the next apply removes them from the repo, unless another selected module still declares them or your `.github/settings.local.yml` does: a label still declared stays rendered and applied.
- `custom-license`: adding it retires the fleet `LICENSE.md` on that sync, and removing it writes the fleet region back above your text; [references/modules.md](references/modules.md#custom-license) has each report outcome.

## Verify

- The sync run's job log ends `row 0: PR opened` or `row 0: branch pushed`, and every Written row is explained by the module diff.
- After merging, the module's leg or job runs on the next push to main (`release` for release-please, `site`). Many modules add no job at all.
- For label-carrying modules, the label exists on the repo after the next settings apply once the sync PR has merged: `gh label list -R Vivswan/<repo>`.

An end-to-end walkthrough, adding `nightly` to a repo that already has `fuzzer`, is in [references/worked-examples.md](references/worked-examples.md).
