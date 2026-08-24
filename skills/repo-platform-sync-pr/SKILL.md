---
name: repo-platform-sync-pr
description: 'Handle an automated template sync PR from Vivswan/repo-platform - triage the PR body, resolve conflicts, restore dropped local lines, and recover a broken sync. Use when a PR titled "chore: update repo-platform template to ..." arrives on branch automation/repo-platform-staging or automation/repo-platform-latest, for "the repo-platform bot PR", "the template update PR", "the automation branch PR", "the copier update PR", when a sync PR warns about merge conflicts or dropped local lines, when "the sync PR deleted my local section", or when a sync run fails with "no base to update from".'
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: Handling a Sync PR

repo-platform pushes template updates into managed repos: a sync run opens (or refreshes) one PR per repo from a rolling automation branch. This skill is how to review that PR, fix conflicts correctly, and escalate when the sync itself is broken.

Work in this order, always:

1. Read the PR body top to bottom (the triage table below).
2. Run the mandatory per-file review pass - every changed file classified and cleared.
3. Resolve: restore dropped lines, hand-edit unresolved files.
4. Merge (or let auto-merge fire on a clean PR).

## When to Apply

- A PR titled `chore: update repo-platform template to staging@<sha>` or `... to templates/vX.Y.Z` appeared, head branch `automation/repo-platform-staging` (or `-latest`)
- The PR body warns about merge conflicts, dropped local lines, retired files, withheld workflow files, settings drift, or failed validation
- A sync run failed with "recorded _commit ... does not resolve" / "no base to update from" (see [references/recovery.md](references/recovery.md))

## What the PR is

- A three-way `copier update`: the template's render at the repo's recorded base (`_commit` in `.copier-answers.yml`, quoted as "Previous:" in the PR body) is diffed against the render at the new ref ("New:"), and that diff is merged onto the repo's current state. Local edits survive unless they overlap a template change.
- The head branch `automation/repo-platform-<channel>` is REGENERATED on every sync run (release, weekly cron, or dispatch) with a lease-guarded force-push. Manual commits sitting on it when the next run starts are overwritten by design; the PR body says so.
- Clean updates arm squash auto-merge: the PR merges itself once the repo's required `all-green` check passes. A PR stays manual-review when any of these hold: auto-resolved conflicts, failed validation, a recovery re-render, a forced-manual dispatch, a deleted license file, withheld workflow files, or out-of-band settings drift.

Find and open the PR from the repo:

```bash
gh pr list --head automation/repo-platform-staging --json number,title,url
gh pr view <number>
```

## Triage: read the PR body top to bottom

Each block tells you what to verify before anything merges:

| Block | Meaning | What to verify |
|---|---|---|
| Settings drift (at the very top) | Live visibility/description differ from the recorded copier answers; merging ratifies the live values | Decide: accept the live values, or revert the out-of-band change first (the block says how) |
| RECOVERY RE-RENDER warning | Dispatched with recover=recopy; no three-way merge happened | See [references/recovery.md](references/recovery.md); review the whole diff and the carry summary |
| Retired modules line | A module the repo listed no longer exists in the template | Confirm the removal is expected |
| "The template retired these files; this update deletes them" | Paths rendered by the old template version but not the new one | Check none were repurposed locally; deletions of repurposed files DO happen and are listed exactly for this review |
| Workflow files WITHHELD warning | The fleet token lacks the Workflows scope; `.github/workflows` changes are missing from the diff | Grant Workflows RW to REPO_PLATFORM_TOKEN in repo-platform and re-run the sync, or accept the partial update |
| License metadata / license deletion warnings | Manifest license claim conflicts, or the update deletes a license file (below-marker content does not survive a delete-vs-modify merge) | Fix the manifest claim; check the old license file for local notices worth moving |
| Merge conflicts warning + per-file summary | Copier hit conflicts; see the conflicts section | Restore dropped lines that should stay; hand-edit files marked unresolved |
| Validation failed warning | The updated tree fails the template validator; the sync run is red | Fix the tree in the PR |

Something that matches none of the above: do not merge - the branch regenerates on the next run, so nothing is lost by waiting. Read the sync run's log (`gh run list -R Vivswan/repo-platform --workflow sync-repos.yml`, then `gh run view <id> -R Vivswan/repo-platform --log-failed`), check repo-platform's `docs/`, and escalate with an issue on Vivswan/repo-platform.

## Review every changed file (mandatory, before anything merges)

Do not resolve, approve, or merge until every file in the diff is accounted for. Warnings in the body cover what the sync KNOWS about; this pass catches what it does not.

1. Enumerate the changed files:

   ```bash
   gh pr diff <number> --name-only
   gh pr view <number> --json files --jq '.files[]|[.path,.additions,.deletions]|@tsv'
   ```

2. Classify each path against the file-class table ([references/file-ownership.md](references/file-ownership.md)): fully managed, generated-once starter, local-section file, mergeable, or repo-owned.
3. Inspect any file you cannot clear from the stats alone. `gh pr diff` takes no pathspec, so use git:

   ```bash
   git fetch origin main automation/repo-platform-staging
   git diff origin/main...origin/automation/repo-platform-staging -- <path>
   ```

4. For each file, verify no repository-local content is being removed. Tell-tale patterns:
   - `+0/-N` (or any large-deletion-dominant diff) on AGENTS.md, `.gitignore`, CONTRIBUTING.md, SECURITY.md, LICENSE.md, `.gitattributes`, `.editorconfig`, or `.github/CODEOWNERS` means local-section content loss - read the full diff for that file and restore what is below the marker (or inside the gitignore LOCAL section) before merging.
   - A generated-once starter (checks.yml, update-release.yml, nightly-fuzz.yml, nightly.yml, issue forms, release-please config, .gitleaks.toml, the `.claude-plugin/` manifests, ...) being MODIFIED or DELETED is suspicious: `_skip_if_exists` files are never touched once they exist. A first-time ADDITION is expected when the same PR's `.repo-platform.yml` diff adds the owning module - "does the modules diff explain it?" is the check. Stop and investigate anything the modules diff does not explain.
   - A `.bun-version`, `.node-version`, or `.dvmrc` addition or version bump is EXPECTED: toolchain pin dotfiles are fully managed, and the fleet shares one pinned version per toolchain - sync PRs deliver pin advances. Do not "restore" the old version; divergence belongs in the repo-owned workflows' version inputs, not the dotfile.
5. Only when every file is classified and cleared, proceed to conflict resolution and merging.

Worked examples of what this pass catches, from live incidents, are in [references/worked-examples.md](references/worked-examples.md).

## Conflicts: what actually lands in the branch

Copier renders overlapping edits as git-style inline conflict blocks (markers reading `before updating` for the local side and `after updating` for the template side) - no `.rej` files, ever. The sync then post-processes every block before pushing, so what you see is:

- Normal case - NO markers in the branch. The template side was kept in place and the local side dropped; the PR body lists every dropped hunk per file: "Conflict N: dropped local lines (template version kept)". The sync run stays green with a warning (auto-resolution is normal operation).
- Managed-tail sentinel files (`repo-platform:local-section` in AGENTS.md, SECURITY.md, CONTRIBUTING.md, fleet LICENSE.md, .gitattributes, .editorconfig, .github/CODEOWNERS): dropped local hunks with content are MOVED below the marker instead of discarded, and the body heading says "moved below the repository-specific marker". A hunk that was a stale copy of the managed half contributes only its tail. Verify the moved lines ended up where you want them.
- `.gitignore` is the exception: its LOCAL section uses BEGIN/END REPOSITORY LOCAL markers, not the sentinel, so the resolver does NOT move its hunks - a true .gitignore conflict is resolved with the local side dropped and reported in the PR body. Re-add the lines inside the LOCAL section yourself.
- Malformed case - markers still in the file. When the marker sequence is broken (nested/out-of-order), the file is left untouched, the body says "Malformed or out-of-order conflict markers; left unresolved for manual editing", validation fails, and the sync run goes red. Edit the file on the branch and resolve each block by hand.
- The body's conflict summary is byte-limited: past ~20 KB whole file sections are omitted with a count; the full list is in the sync run's log (public repos) or reproducible locally (private repos).

## Decide per file class

What "restore the dropped lines" means depends on who owns the file (the full table is in [references/file-ownership.md](references/file-ownership.md)):

- Fully managed (ci.yml, dependabot.yml, callers, .copier-answers.yml, the toolchain pin dotfiles, ...): accept the template side. These files are template-owned: overlapping local edits lose to the template (an edit the template happens not to touch can survive a given sync, but it is living on borrowed time). Move the need upstream (a template change in repo-platform) or into a repo-owned file (checks.yml for CI jobs). One carve-out: changing a module parameter (nightly_label, skills_dir, pages_*, fuzzer_label, ...) is done by editing that question's VALUE key in .copier-answers.yml via a normal default-branch PR - never the underscore keys.
- Generated-once starters (checks.yml, update-release.yml, nightly-fuzz.yml, nightly.yml, issue forms, release-please config, .gitleaks.toml, the .claude-plugin manifests, ...): never touched once they exist, so they do not conflict. Additions are explained by the modules diff; modifications or deletions are not - stop and look.
- Managed-tail sentinel files (AGENTS.md, SECURITY.md, CONTRIBUTING.md, LICENSE.md, .gitattributes, .editorconfig, .github/CODEOWNERS below the marker): local content belongs BELOW the marker. If a dropped hunk was above the marker, re-add it below instead of restoring it in place.
- `.gitignore`: local entries belong inside the BEGIN/END REPOSITORY LOCAL section; conflict hunks there come back via the PR body, not a move (see above).
- `.github/settings.yml`: restore dropped hunks before merging. A key the resolution dropped toward the template is declared empty, and the nightly settings heal then CLEARS the live value (homepage, topics) - the dropped-hunk warning is the only tell.

## Fix the PR

The branch name is constant and force-pushed every run, so a stale local copy of it bites - always reset to the remote:

```bash
git fetch origin
git checkout -B automation/repo-platform-staging origin/automation/repo-platform-staging   # or -latest
# restore hunks / hand-resolve malformed files
git commit -am "fix: restore repository-local lines after template sync"
git push origin automation/repo-platform-staging
```

- Pushing more commits is the supported way to fix the PR; CI re-runs on the push. Needs-review PRs are never auto-merged, so merge manually when green.
- Merge PROMPTLY. The PR body's "manual commits pushed to it are overwritten" and this workflow are both true: commits parked on the branch BETWEEN runs are replaced by the next run's force-push, so fix-then-merge before the next release, weekly cron, or dispatch. A push that lands while a sync run is already in flight trips that run's lease and turns the run red (loud, not lost) - the silent overwrite is only the between-runs case.
- Do not rebase the automation branch onto the default branch or force-push it yourself - the next run replaces it wholesale anyway, and an out-of-band force-push just trips the lease.

## Closing instead of fixing

Closing the PR is not an opt-out: the next sync run pushes the branch again and opens a fresh PR, with the same conflicts (the local edits that caused them are still there). Close-and-wait only makes sense when you know the conflicting local edit is about to move to its proper home or land in the template itself.

To actually pause sync PRs: add the repo to `exclude:` in repo-platform's `repos.yml`, or delete `.repo-platform.yml` from the repo (sync skips repos without it, with a notice). Both also pause the nightly settings heal for in-repo settings. To detach permanently, see repo-platform's [docs/eject.md](https://github.com/Vivswan/repo-platform/blob/main/docs/eject.md).

## Recovery: the recorded base is unusable

When a sync run fails with "recorded _commit ... does not resolve ... there is no base to update from", the fix is a `recover=recopy` dispatch that delivers a full re-render through a manual-review PR. Symptoms and where they surface, causes, the exact dispatch command, what the recovery PR contains (including how repository-local content is carried over and the one WRONG way to restore a file), and how to repair a pre-carry-fix recovery PR are in [references/recovery.md](references/recovery.md).
