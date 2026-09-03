# Ejecting a repository from repo-platform management

Detaching is cheap by design: managed repos degrade to normal repos, not broken ones. Nothing at runtime depends on repo-platform except workflow `uses:` references, which keep working as long as repo-platform exists:

| Reference | Pinned at |
|---|---|
| every reusable-workflow call (fleet CI, auto-assign, pages, settings-sync), the [all-green gate action](all-green.md), every composite-action step | `@build` (repo-platform's green-gated delivery branch - [build-provenance.md](build-provenance.md)) |

Management is push-based, so ejecting starts in repo-platform, not in the repo: stop the machinery here, then optionally strip the managed files there.

## 1. Deregister in repo-platform

Either of these stops sync PRs:

- add the repo to the `exclude:` list in `repos.yml`, or
- revoke the fleet PAT's access to the repo (discovery only enrolls repos the token can write to).

Settings stop being applied too: the nightly heal only manages enrolled repos whose `.repo-platform.yml` selects the settings-sync module ([settings.md](settings.md)).

## 2. (Optional) Strip the managed files in the repo

1. Delete the management metadata:

   ```bash
   git rm .github/.copier-answers.yml .repo-platform.yml
   ```

2. Rewrite `.github/workflows/ci.yml`. The managed file is a thin caller of repo-platform's `fleet-ci.yml` reusable, and that call is all-or-nothing: its `validate-template` job goes red once `.github/.copier-answers.yml` and `.repo-platform.yml` are gone, and no input turns it off. Replace the `ci` job:
   - copy the jobs you want out of `fleet-ci.yml` into ci.yml (the composite actions they call stay public; replace each job's `inputs.*` conditions and values with your repo's literals - a plain workflow has no workflow_call inputs), or write your own
   - ci.yml's `all-green` job keeps judging whatever its needs list names; drop it too if you drop the `all-green` required check from your branch protection

3. (Optional) Inline the reusable workflows. Skip this if repo-platform continues to exist - the pinned references keep working unchanged. Otherwise:
   - replace each thin caller (`auto-assign.yml`, `pages.yml`, `settings-sync.yml`, the `ci` job's `fleet-ci.yml` call, the `all-green` job's action step) with a copy of the corresponding `reusable-*.yml`/fleet job/action from repo-platform
   - replace `uses: Vivswan/repo-platform/actions/...` steps with vendored copies of the action scripts
   - CodeQL runs inside fleet-ci's `codeql` matrix; inline repo-platform's `reusable-codeql.yml` too if you want CodeQL without repo-platform
   - the `pr-title.yml` workflow needs nothing: it uses a public action directly (drop its required check from the `pr-title` ruleset if you delete it)

4. (Optional) Strip the marker comments from `.gitignore`. The content keeps working either way.

5. Commit:

   ```bash
   git commit -m "chore: detach from repo-platform management"
   ```

Every remaining file (settings.yml, AGENTS.md, editorconfig, gitignore content, CI jobs) is plain configuration that works standalone.

## Pause instead of eject

To stop receiving sync PRs without detaching, either:

- add the repo to `repos.yml`'s `exclude:` list (fleet side), or
- delete `.repo-platform.yml` from the repo (the sync skips repos without it, with a notice).

Undo either one to resume updates. Both pauses also stop the central nightly settings heal for a repo using the in-repo settings home - but only the exclusion is reported loudly (the settings run warns nightly, with a step-summary bullet). The deleted-file pause only leaves a notice in the run log, so check there if you forget which repos are paused.
