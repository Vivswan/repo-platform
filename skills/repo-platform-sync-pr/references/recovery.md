# Recovery: recover=recopy for an unusable recorded base

## Symptom

The sync leg fails red with exactly this error (no PR arrives):

> ::error::<repo>'s recorded _commit '<value>' does not resolve on Vivswan/repo-platform's build branch, so there is no base to update from. Fix the _commit in its .copier-answers.yml, or dispatch Sync Repos with repo=<the repository's real owner/name> (shown here as <repo>) and recover=recopy to regenerate the repo through a manual-review PR.

Where it surfaces depends on visibility:

- Public repos: nothing appears in the repo itself. Find the failure in repo-platform's run log:

  ```bash
  gh run list -R Vivswan/repo-platform --workflow sync-repos.yml
  gh run view <id> -R Vivswan/repo-platform --log-failed
  ```

- Private repos: the public log hides details; the diagnostics are auto-filed as an issue in the target repo itself, titled `[automated] repo-platform sync: private failure report` (one reused issue; open means the sync needs attention).

## Why it happens

`template` is an append-only orphan branch, so a recorded `_commit` normally stays resolvable forever. It breaks when:

- the template branch was recreated (its old commits are orphaned),
- the repo was generated from a local repo-platform checkout whose commit never existed upstream,
- `.copier-answers.yml`'s `_commit` was hand-edited, or
- the repo predates the build-branch architecture and records a main-history commit that a main rewrite orphaned.

## The fix

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform \
  -f repo=<owner/name> -f recover=recopy
```

For every managed repo at once, pass the literal `all`:

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform \
  -f repo=all -f recover=recopy
```

The repo input is required either way - a recovery dispatch without it is rejected, so recovery stays a deliberate act.

`repo=all` is for fleet-wide breakage (a recreated template branch, say), not routine use: it applies the destructive recovery path to every managed repo, including ones that never needed it - managed-half edits are overwritten everywhere, retired-file cleanup is skipped fleet-wide, and every open auto-merging sync PR is flipped to manual review.

One fleet run fans out to every repo in parallel, and failures stay isolated per leg: every repo is attempted, the run goes red if any leg failed, but there is no aggregate summary - list the failed legs with `gh run view <id> -R Vivswan/repo-platform --log-failed` (a public repo's failure surfaces nowhere else; a private repo self-files its failure-report issue, as above). One sharp edge: each leg disarms auto-merge BEFORE it pushes the branch and updates the PR, so a leg that fails exactly there (rate limiting's favorite spot) leaves that repo's previously-armed PR disarmed with no new content - re-running the recovery for that repo heals it.

## What the recovery PR contains

`copier recopy --overwrite` - a full re-render with NO three-way merge - followed by a carry step that splices repository-local content back:

- Managed-tail sentinel files (AGENTS.md, `.gitattributes`, `.editorconfig`, `.github/CODEOWNERS`, SECURITY.md, CONTRIBUTING.md, fleet LICENSE.md) all take ONE carry path with three possible dispositions, each reported in the PR body's carry summary:
  - kept-whole: the repo's copy starts with the fresh render, so it is kept as-is.
  - tail-appended: only when the render's final non-blank line is a recognized sentinel. The repo's copy is split at its FIRST `repo-platform:local-section` sentinel and everything after it - including any further sentinel lines - is re-appended below the fresh render's sentinel. When the previous copy carried more than one marker, the summary bullet adds "review the tail for stale duplicates" - do that review; a stale second managed half may be riding along in the tail. And when the managed half above the repo's marker differed from the fresh render (in-place edits there), the bullet adds "the managed half above the marker differed from the fresh render; those differences are not carried - review the diff": recovery legitimately resets the managed half, but the drop is loud, so check whether any of those edits deserve a home below the marker or in the template.
  - appendix: anything unsplittable (no sentinel in the repo's copy - including legacy copies synced before the sentinels existed). The previous copy is preserved IN FULL below a recovery-appendix comment - `# repo-platform:recovery-appendix ...` in hash-comment files like `.gitattributes`, `<!-- repo-platform:recovery-appendix ... -->` otherwise - and needs manual deduplication. Loud over lossy: an appendix in AGENTS.md or `.gitattributes` is expected behavior, not a bug. `.editorconfig` and `.github/CODEOWNERS` carry the newest sentinels, so during the transition window (repos not yet synced past the sentinel's introduction) they are the most likely appendix producers. And unlike `.gitignore`'s appendix, which is commented out and inert, an `.editorconfig` or CODEOWNERS appendix is LIVE: both formats apply the LAST match, so the duplicated previous copy below the appendix comment governs until you dedupe it. That is the conservative-correct behavior (the repo's previous rules keep winning, exactly as before the recovery) - just do not expect the .gitignore-style "nothing applies until restored" promise here.
- The `.gitignore` BEGIN/END REPOSITORY LOCAL section body is carried over. When the repo copy's LOCAL markers are mangled, duplicated, or missing, the WHOLE previous copy is preserved inside the fresh LOCAL section under a `# repo-platform:recovery-appendix` comment - fully commented out (marker text dash-joined so validation still passes), so none of its entries apply until a human moves the repository-local lines back up uncommented and deletes the block. The carry summary bullet says so - the same loud-over-lossy appendix expectations as above.
- A file whose local tail is blank has nothing to carry: that is a no-op, not a loss.

The carry summary lists only files the carry actually CHANGED - a file absent from the list was either untouched or never customized. Check every bullet against what you expect the repo's local content to be; the mandatory per-file review pass applies to recovery PRs doubly, never trust the carry blindly.

Everything else about the re-render:

- Edits to the MANAGED half of template-managed files are overwritten in the diff (that is the point of the recovery).
- Generated-once (`_skip_if_exists`) files survive, and copier deletes nothing; `.github/settings.yml` is restored outright, and a custom-license repo's own license survives untouched.
- Retired-file cleanup is skipped (no trustworthy old render to diff against), so stale template files may linger - remove them by hand if you spot them.
- The PR always stays manual-review; merging it re-records a resolvable `_commit`, and the next sync is a normal three-way update again.

## Repairing a recovery PR that lost local content

Recovery PRs generated BEFORE the carry step existed (and any future regression) show deletion-dominant diffs on the managed-tail sentinel files or `.gitignore`: `+0/-N` on AGENTS.md, SECURITY.md, CONTRIBUTING.md, LICENSE.md, `.gitattributes`, `.editorconfig`, `.github/CODEOWNERS`, or `.gitignore`. Do not merge one of those. Two fixes:

- Preferred: re-dispatch the recovery (same command as above). The branch is force-pushed fresh, so the new run - with the carry step - heals the open PR in place.
- Manual: re-append the below-marker block on the automation branch. Read the base branch's copy and re-attach ONLY the local part:

  ```bash
  git fetch origin
  git checkout -B automation/repo-platform origin/automation/repo-platform
  git show origin/main:AGENTS.md   # copy everything BELOW the
                                   # repo-platform:local-section line,
                                   # paste it below the marker on the branch
  ```

  The WRONG restore is `git checkout origin/main -- AGENTS.md`: that reverts the whole file, managed half included, undoing the template update the PR exists to deliver. The correct mechanic is always re-appending the below-marker block (for `.gitignore`, the lines inside the BEGIN/END REPOSITORY LOCAL section).

## Prevention

- Never hand-edit `_commit` in `.copier-answers.yml`, and never delete the file.
- Generate new repos from `gh:Vivswan/repo-platform` build refs, not from a local checkout.
