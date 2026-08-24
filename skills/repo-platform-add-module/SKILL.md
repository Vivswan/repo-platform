---
name: repo-platform-add-module
description: 'Add or remove a Vivswan/repo-platform module in a managed repository - edit the modules list, set module parameters, get the sync PR, and finish the companion steps. Use when someone says "add a module", "enable the fuzzer", "add nightly CI to this repo", "turn on pages", "host skills in this repo", "enable settings-sync", "add the bun toolchain", "add Python support to this repo", "add Rust support", "start cutting releases here", "publish the docs site", "check PR titles on this repo", "remove a module", "drop the fuzzer", "disable nightly", asks "what modules does this repo have", or asks how to change a module parameter like nightly_label, fuzzer_label, skills_dir, or the pages build command.'
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: Adding or Removing a Module

Module selection is repo-owned: the top-level `modules:` list in the repository's own `.repo-platform.yml`. Change it on the default branch (a normal PR), and the next template sync PR renders the change - no edits in repo-platform are needed for the selection itself, only for central settings labels.

Work in this order, always:

1. Edit `modules:` in `.repo-platform.yml` (and any module parameter in `.copier-answers.yml`, same PR) and merge.
2. Get the sync PR (wait for the weekly cron / next release, or dispatch it now) and review every changed file before it merges.
3. Finish the module's companion steps (labels, secrets, one-time setup, starter customization).

## When to Apply

- "Enable the fuzzer" / "add nightly CI" / "turn on pages" / "host skills in this repo" / "add the uv toolchain" on a repo that already carries `.repo-platform.yml`
- Outcome-shaped asks that map to a module: "add Python/Rust support to this repo" (uv/rust), "start cutting releases here" (release-please), "publish the docs site" (pages), "check PR titles" (pr-title), "what modules does this repo have" (read `.repo-platform.yml`)
- "Remove a module" / "drop the fuzzer" / "we do not need issue-templates anymore"
- "Change nightly_label" / "move the skills directory" / "change the pages build command" - module parameters, not selection

For enrolling a repo that is not managed yet, use the `repo-platform-new-project` skill instead. And inside repo-platform itself, "add a module" means authoring a new `templates/<module>/` folder (its CLAUDE.md covers that) - this skill is for managed repos.

## The module roster

One line each. The roster's source of truth is the module manifests (`templates/<module>/module.yml` in repo-platform), which generate the `modules` question's `choices` in `copier.yml` - that choices list is the practical reference from a managed repo; when this table and it disagree, it wins.

| Module | What it gives the repo |
|---|---|
| `agents` | AGENTS.md agent instructions, agent-file symlinks, Copilot setup |
| `bun` | TypeScript/bun toolchain (gitignore, dependabot, CodeQL JS) |
| `node` | JavaScript/Node.js toolchain (gitignore, npm dependabot, CodeQL JS) |
| `deno` | Deno toolchain (deno fmt/lint, deno dependabot, CodeQL JS) |
| `uv` | Python/uv toolchain (gitignore, dependabot, CodeQL Python) |
| `rust` | Rust/cargo toolchain (cargo dependabot, Rust gitignore; no CodeQL) |
| `pages` | GitHub Pages deploy (root = latest release, /staging/ = main) |
| `release-please` | release job on top of all-green + autorelease labels |
| `issue-templates` | bug/feature issue forms |
| `skills` | agent skills hosting (plugin manifests, skill validation) |
| `pr-title` | Conventional Commit PR title check in the all-green gate |
| `auto-assign` | auto-assign issues/PRs/alerts to owner |
| `fuzzer` | nightly fuzz starter with issue filing, replay inputs, auto-close |
| `nightly` | nightly CI starter with failure issue filing and auto-close |
| `settings-sync` | in-repo .github/settings.yml applied with the repo's own PAT |
| `custom-license` | repo carries its own license in LICENSE.md; the fleet license is not rendered |

Per-module details - what is managed vs starter, parameters, companion steps, removal notes - are in [references/modules.md](references/modules.md).

## Adding a module

### 1. Edit the selection (and parameters) on the default branch

```bash
# .repo-platform.yml - add the module name to the top-level list:
modules: ["agents", "release-please", "issue-templates", "pr-title", "auto-assign", "nightly"]
```

A typo is safe: a name the template does not know fails the sync run loudly instead of being dropped - and the safety net fires earlier than that: the informational `validate-template` job on the step-1 PR itself flags an unknown module name before merge. Two more caveats:

- Older repos nest the selection under `template:`; add a top-level `modules:` list, which wins.
- A brand-new module reaches a repo only through a template ref that ships it: `latest`-channel repos wait for a template release, and `staging`-channel repos need the staging branch rebuilt from the main merge that added it - either way, delivery still waits for the next sync run (weekly cron, release, or dispatch); the rebuild alone syncs nothing.

Expected-red window when adding a toolchain module (bun/node/deno): after the step-1 merge, `validate-template` reports the missing toolchain pin dotfile (`.bun-version` / `.node-version` / `.dvmrc`) until the sync PR lands it. That job is informational, not gating - do not hand-create the dotfile.

If the module has a parameter and you do NOT want its default, record the answer in `.copier-answers.yml` in the same PR (see "Module parameters" below). With no recorded answer, the sync uses the default.

Merge the PR. Nothing renders yet - the render happens in the sync.

### 2. Get the sync PR

Sync PRs arrive on template releases and the weekly cron (Tuesday 08:50 UTC). A module edit alone is enough to produce one (the selection is a live input; the sync re-renders even at an unchanged template ref). To sync immediately:

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo>
```

No PR after a few minutes? Check the run before concluding nothing happened - a dispatch can be silently cancelled by the `sync-repos` concurrency group when another sync run is already pending ("a higher priority waiting request exists"):

```bash
gh run list -R Vivswan/repo-platform --workflow sync-repos.yml
gh run view <id> -R Vivswan/repo-platform --log-failed
```

That log is where a failed sync explains itself for PUBLIC target repos - they get no failure issue. Only private (hidden-detail) targets receive a failure-report issue on the repo itself, because their details must stay out of the public log.

### 3. Review every changed file (mandatory)

The sync PR is an ordinary template sync PR: before anything merges, classify and clear every file in its diff using the `repo-platform-sync-pr` skill's per-file review pass (it installs independently: [skills/repo-platform-sync-pr](https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-sync-pr)). The check specific to a module change: "does the modules diff explain this file?" - every addition should trace to the module you added.

What the PR delivers, in two classes:

- Managed files: arrive now and keep updating on every future sync (workflow callers, ci.yml jobs, dependabot entries, gitignore sections). Do not edit them.
- Generated-once starters (`_skip_if_exists`): arrive once, then repo-owned - sync never touches them again. Modules that ship starters: `fuzzer` (`nightly-fuzz.yml`), `nightly` (`nightly.yml`), `skills` (`.claude-plugin/plugin.json` + `marketplace.json`), `release-please` (`release.yml`, `release-please-config.json`, `.release-please-manifest.json`), `issue-templates` (issue forms + chooser), `agents` (`copilot-setup-steps.yml`), and any formatter toolchain (bun/node/deno/uv, not rust: `auto-format.yml` gains that toolchain only if the file does not exist yet). A starter that already exists is never re-rendered - a repo adopting `skills` with existing manifests keeps them untouched.

### 4. Finish the companion steps

The full checklist per module is in [references/modules.md](references/modules.md). The ones that bite when skipped:

- Central-settings repos (a `settings/repos/<name>.yml` in repo-platform that declares labels): add every label the new module requires - the tracking label for `fuzzer`/`nightly` (the `fuzzer_label`/`nightly_label` answer), the dependabot label for a new toolchain, the `autorelease: *` pair plus `release-blocker`/`release-override` for `release-please`. The repo owner adds them via a PR in repo-platform; the tuples come from the module manifests (`templates/<module>/module.yml`) and the release-please module's settings-labels fragment - the settings-sync template only assembles them via anchors, so the easiest full roster to copy from is a settings-sync repo's rendered `.github/settings.yml`. The settings preflight compares the file against the modules list in the repo's `.repo-platform.yml` (live as soon as step 1 merges) and the tracking-label answer in its `.copier-answers.yml`, and fails the apply on a missing required label - so land the central label PR FIRST (extra labels never error; missing ones do), and record the tracking-label answer in the step-1 PR even when accepting the default, or the preflight cannot read it until the sync PR merges. Repos with the `settings-sync` module get the declarations rendered automatically.
- `bun`: register a repo-scoped Contents:RW PAT as a DEPENDABOT secret so the lockfile fixer's push re-runs CI (human-only - needs the token value): `gh secret set REPO_PLATFORM_TOKEN --app dependabot`.
- `pages`: one-time repo setup - Settings -> Pages -> Source: GitHub Actions, and a `v*` tag rule on the `github-pages` environment's deployment branches.
- `skills`: the starter manifests are repo-owned - a skill folder is unpublished until `plugin.json`'s `skills` array lists it.
- `fuzzer` / `nightly`: replace the starter's placeholder step with real work; until then it is a green no-op that never files issues.

## Module parameters

How the sync actually renders answers: it passes only `modules` (from `.repo-platform.yml`), `channel` (fleet config), and the live `private`/`description` as data. Every other answer - `nightly_label`, `fuzzer_label`, `skills_dir`, the `pages_*` set, `homepage`, `topics`, `copyright_holder` - is loaded from the repo's recorded `.copier-answers.yml`, and a question with no recorded answer (a module just added) takes its `copier.yml` default.

So the parameter mechanism is the recorded answers file, edited by PR on the default branch:

```bash
# Same PR as the modules edit (or its own PR later):
# .copier-answers.yml - add or change the VALUE key:
#   nightly_label: slow-suite-failure
git checkout -b add-nightly
# edit .repo-platform.yml (modules) and .copier-answers.yml (answer)
git commit -am "chore: add the nightly module with a custom label"
gh pr create && gh pr merge --auto --squash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo>
```

The answers file holds three classes of key - know which one you are touching:

- `_`-prefixed keys (`_commit`, `_src_path`): never touch them, and never delete the file - `copier update` depends on them, and a broken `_commit` puts the repo on the recovery path.
- `modules`, `channel`, `private`, `description`: recorded here, but force-overridden by the sync every run - an edit here silently evaporates. Change them at their real source: `.repo-platform.yml` for modules, repo-platform's `repos.yml` for channel, the live GitHub settings for visibility and description.
- Everything else (the module parameters above): editing the value key here IS the mechanism. The next sync re-renders everything derived from the answer and rewrites `.copier-answers.yml` itself consistently; an answer that violates its copier validator fails the sync run loudly. The settings preflight reads tracking labels from exactly this file on the default branch, so central labels must match what it records.

When both `fuzzer` and `nightly` are selected, their labels must differ (case-insensitively - GitHub deduplicates label names that way): both streams dedup AND auto-close by label, so a shared label lets one stream's green night close the other's open issue. The copier validator and the settings preflight both reject the collision.

One ripple to remember: renaming a tracking label (`fuzzer_label`/`nightly_label`) never updates the repo-owned starter workflow - update the starter's two `label:` inputs in the same PR, or it keeps filing under the old name while the settings apply deletes that label. The settings declaration side splits by settings home: settings-sync repos get the rendered `settings.yml` declaration updated automatically on the next sync; central-settings repos need a matching PR to `settings/repos/<name>.yml` in repo-platform, or the preflight fails the apply.

## Removing a module

Deselecting works the same way: remove the name from `modules:` in `.repo-platform.yml`, merge, and the next sync PR cleans up. What actually happens:

- Managed files the module owned leave the render and are deleted - including locally modified ones (the retired-file cleanup diffs two clean renders; every removal is listed in the PR body for review). Check none were repurposed locally before merging.
- Starters and repo-owned files stay: `_skip_if_exists` files are never deleted by sync. Dropping `fuzzer`/`nightly` leaves `nightly-fuzz.yml`/`nightly.yml` running - delete the workflow yourself, or keep its tracking label declared in your settings.
- `.github/settings.yml` is never deleted by sync, even when dropping `settings-sync` de-renders it. Moving to central settings: copy the content to `settings/repos/<name>.yml` in repo-platform, then remove the in-repo file yourself (while both exist, central wins).
- Dropping `custom-license` is guarded: the sync FAILS with instructions while the repo's own license file still exists, because the incoming fleet LICENSE.md cannot be reconciled with it. Delete the old license in the same commit that removes the module (git history records prior licensing; third-party notices go below the fleet LICENSE.md's local-section marker), then re-run the sync.
- Label cleanup: labels only the dropped module required can be removed from the central settings file (the apply then deletes them from the repo). Do not remove a tracking label whose workflow you kept.

A module the TEMPLATE retired (rather than you deselecting it) is handled automatically: the sync drops it from the selection with a notice and the same cleanup rules apply.

## Verify

- The sync run is green and the PR's diff is fully explained by the modules diff (step 3 above).
- After merging: any managed CI jobs the module adds (CodeQL for a toolchain on a public repo, `release-freshness`/`release-health` for release-please, `validate-skills` for skills, `pr-title`) appear in the repo's `all-green` gate on the next PR - many modules add no gated job at all - and starters exist and are ready to fill in.
- For label-carrying modules: the next settings apply is green (`gh workflow run settings-repos.yml -R Vivswan/repo-platform -f check_only=true -f repo=Vivswan/<repo>` for a dry run).

Two end-to-end walkthroughs - adding `nightly` to a repo that already has `fuzzer`, and adding `skills` - are in [references/worked-examples.md](references/worked-examples.md).
