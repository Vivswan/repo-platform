# Ejecting a repository from repo-platform management

Detaching is cheap by design: managed repos degrade to normal repos, not broken ones. Nothing at runtime depends on repo-platform except workflow `uses:` references, which keep working as long as repo-platform exists (the per-feature reusable-workflow calls pin `main`; fleet CI, the all-green verdict, and every composite-action step pin the `build` branch, repo-platform's green-gated delivery channel).

Management is push-based, so ejecting starts in repo-platform, not in the repo: stop the machinery here, then optionally strip the managed files there.

## 1. Deregister in repo-platform

In `repos.yml`:

1. Add the repo to the `exclude:` list, or revoke the fleet PAT's access to the repo (discovery only enrolls repos the token can write to); either stops sync PRs.

Settings stop being applied with the pause too: the nightly heal only manages enrolled repos whose `.repo-platform.yml` selects the settings-sync module.

## 2. (Optional) Strip the managed files in the repo

1. Delete the management metadata:

   ```bash
   git rm .copier-answers.yml .repo-platform.yml
   ```

2. Rewrite `.github/workflows/ci.yml`: the managed file is a thin caller of repo-platform's `fleet-ci.yml` reusable, and that call is all-or-nothing - its `validate-template` job goes red once `.copier-answers.yml` and `.repo-platform.yml` are gone, and no input turns it off. Replace the `ci` job: copy the jobs you want out of `fleet-ci.yml` into ci.yml (the composite actions they call stay public; replace each job's `inputs.*` conditions and values with your repo's literals - a plain workflow has no workflow_call inputs), or write your own. The managed `all-green.yml` verdict workflow keeps judging whatever jobs remain; delete it too if you drop the `all-green` required check from your branch protection.

3. (Optional) Inline the reusable workflows. Replace each thin caller (`auto-assign.yml`, `pages.yml`, `settings-sync.yml`, the `ci` job's `fleet-ci.yml` call, `all-green.yml`'s `reusable-all-green.yml` call) with a copy of the corresponding `reusable-*.yml`/fleet job from repo-platform, and replace `uses: Vivswan/repo-platform/actions/...` steps with vendored copies of the action scripts. CodeQL runs inside fleet-ci's `codeql` matrix; inline repo-platform's `reusable-codeql.yml` too if you want CodeQL without repo-platform. The `pr-title` job needs nothing: it uses a public action directly. Skip this if repo-platform continues to exist; the pinned references (reusable workflows at `main` or the `build` branch, composite actions at `build`) keep working unchanged.

4. (Optional) Strip the marker comments from `.gitignore`. The content keeps working either way.

5. Commit:

   ```bash
   git commit -m "chore: detach from repo-platform management"
   ```

Every remaining file (settings.yml, AGENTS.md, editorconfig, gitignore content, CI jobs) is plain configuration that works standalone.

## Pause instead of eject

To stop receiving sync PRs without detaching, either add the repo to `repos.yml`'s `exclude:` list (fleet side) or delete `.repo-platform.yml` from the repo (the sync skips repos without it, with a notice). Undo either one to resume updates. Both pauses also stop the central nightly settings heal for a repo using the in-repo settings home, but only the exclusion is reported loudly: the settings run warns nightly, with a step-summary bullet. The deleted-file pause only leaves a notice in the run log, so check there if you forget which repos are paused.
