# Ejecting a repository from repo-platform management

Detaching is cheap by design: managed repos degrade to normal repos, not broken ones. Nothing at runtime depends on repo-platform except workflow `uses:` references, which keep working as long as repo-platform exists:

| Reference | Pinned at |
|---|---|
| every reusable-workflow call (fleet CI, auto-assign, pages), the [all-green gate action](all-green.md), every composite-action step | `@build` (repo-platform's green-gated delivery branch - [build-provenance.md](build-provenance.md)) |

Management is push-based, so ejecting starts in repo-platform, not in the repo: stop the machinery here, then optionally strip the managed files there.

## 1. Deregister in repo-platform

Revoke the fleet token's write access to the repo (its repository access list on the REPO_PLATFORM_TOKEN). Leaving the fleet = revoking the fleet token's write access. A private repository then disappears from discovery; a public one stays listed, and every plan whose scope selects that repository prints one notice that the token cannot push to it. Nothing is deleted either way. Nothing in repo-platform lists the fleet, so there is nothing else to edit.

Settings stop being applied too: the nightly heal only manages enrolled repos with a `.repo-platform.yml` ([settings.md](settings.md)).

## 2. (Optional) Strip the managed files in the repo

1. Delete the management metadata:

   ```bash
   git rm .github/.copier-answers.yml .repo-platform.yml
   ```

2. Rewrite `.github/workflows/ci.yml`. The managed file is a thin caller of repo-platform's `fleet-ci.yml` reusable, and that call is all-or-nothing: its `validate-template` job goes red once `.github/.copier-answers.yml` and `.repo-platform.yml` are gone, and no input turns it off. Replace the `ci` job:
   - copy the jobs you want out of `fleet-ci.yml` into ci.yml (the composite actions they call stay public; replace each job's `inputs.*` conditions and values with your repo's literals - a plain workflow has no workflow_call inputs), or write your own
   - ci.yml's `all-green` job keeps judging whatever its needs list names; drop it too if you drop the `all-green` required check from your branch protection

3. (Optional) Inline the reusable workflows. Skip this if repo-platform continues to exist - the pinned references keep working unchanged. Otherwise:
   - replace each thin caller (`auto-assign.yml`, `pages.yml`, the `ci` job's `fleet-ci.yml` call, the `all-green` job's action step) with a copy of the corresponding `reusable-*.yml`/fleet job/action from repo-platform
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

- revoke the fleet token's write access to the repo (fleet side - the same step as deregistering; re-grant it to resume), or
- delete `.repo-platform.yml` from the repo (the sync skips repos without it, with a notice).

Undo either one to resume updates. Both pauses also stop the central nightly settings heal for a repo using the in-repo settings home. In the plan log a revoked public repo stays listed, and every plan whose scope selects that repository prints one notice that the token cannot push to it; a revoked private repo shows nothing (it is no longer discovered), and the deleted-file pause shows a "not adopted" notice; the token's repository access list is the authoritative view of which repos are paused.
