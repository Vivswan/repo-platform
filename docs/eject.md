# Ejecting a repository from repo-platform management

Detaching is cheap by design: managed repos degrade to normal repos, not
broken ones. Nothing at runtime depends on repo-platform except workflow
`uses:` references, which keep working as long as repo-platform exists
(latest-channel repos pin release tags; staging-channel repos pin `main`).

Management is push-based, so ejecting starts in repo-platform, not in the
repo: stop the machinery here, then optionally strip the managed files
there.

## 1. Deregister in repo-platform

In `repos.yml`:

1. Add the repo to the `exclude:` list (the wildcard would otherwise keep
   discovering it; this stops sync PRs).
2. Remove its `config:` entry, if it has one.

Then delete `settings/repos/<name>.yml`, if the repo uses the central
settings home, so settings stop being applied.

## 2. (Optional) Strip the managed files in the repo

1. Delete the management metadata:

   ```bash
   git rm .copier-answers.yml .repo-platform.yml
   ```

2. Edit `.github/workflows/ci.yml`: remove the `validate-template` job and
   its entry in all-green's `needs` list. That job enforces the managed-file
   conventions and fails once `.copier-answers.yml` and `.repo-platform.yml`
   are gone. With sync PRs stopped, ci.yml is yours to edit; the remaining
   jobs (typography, commit-names, actionlint, yamllint, checks, module
   jobs) keep working standalone.

3. (Optional) Inline the reusable workflows. Replace each thin caller
   (`auto-assign.yml`, `pages.yml`, `settings-sync.yml`) with a copy of the
   corresponding `reusable-*.yml` job from repo-platform, and replace
   `uses: Vivswan/repo-platform/actions/...` steps with vendored copies of
   the action scripts. The `codeql-*` jobs inside ci.yml call
   repo-platform's `reusable-codeql.yml`; inline that one into ci.yml too
   if you want CodeQL without repo-platform. The `pr-title` job needs
   nothing: it uses a public action directly. Skip this if repo-platform
   continues to exist; the pinned references (release tags on the latest
   channel, `main` on staging) keep working unchanged.

4. (Optional) Strip the marker comments from `.gitignore`. The content keeps
   working either way.

5. Commit:

   ```bash
   git commit -m "chore: detach from repo-platform management"
   ```

Every remaining file (settings.yml, AGENTS.md, editorconfig, gitignore
content, CI jobs) is plain configuration that works standalone.

## Pause instead of eject

To stop receiving sync PRs without detaching, either add the repo to
`repos.yml`'s `exclude:` list (fleet side) or delete `.repo-platform.yml`
from the repo (the sync skips repos without it, with a notice). Undo
either one to resume updates.
