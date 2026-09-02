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

`build` is an append-only orphan branch, so a recorded `_commit` normally stays resolvable forever. It breaks when:

- the build branch was recreated (its old commits are orphaned),
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

`repo=all` is for fleet-wide breakage (a recreated build branch, say), not routine use: it applies the destructive recovery path to every managed repo, including ones that never needed it - managed-half edits are overwritten everywhere, retired-file cleanup is skipped fleet-wide, and every open auto-merging sync PR is flipped to manual review.

One fleet run fans out to every repo in parallel, and failures stay isolated per leg: every repo is attempted, the run goes red if any leg failed, but there is no aggregate summary - list the failed legs with `gh run view <id> -R Vivswan/repo-platform --log-failed` (a public repo's failure surfaces nowhere else; a private repo self-files its failure-report issue, as above). One sharp edge: each leg disarms auto-merge BEFORE it pushes the branch and updates the PR, so a leg that fails exactly there (rate limiting's favorite spot) leaves that repo's previously-armed PR disarmed with no new content - re-running the recovery for that repo heals it.

## What the recovery PR contains

`copier recopy --overwrite` - a full re-render with NO three-way merge - followed by a carry step that splices repository-local content back:

- Every split file (AGENTS.md, `.gitattributes`, `.editorconfig`, `.github/CODEOWNERS`, SECURITY.md, CONTRIBUTING.md, fleet LICENSE.md, `.gitignore`) takes ONE carry path with these dispositions, each reported in the PR body's carry summary:
  - sides restored: the repo's copy is sliced at its BEGIN/END managed-region markers and everything outside the region (above and below) is re-seated around the fresh render's region byte-for-byte. A copy still in a RETIRED shape (the old `repo-platform:local-section` tail marker, or the old `.gitignore` LOCAL region) is CONVERTED the same way - the tail lands below the new END marker, the old above-content rides through above BEGIN - and the bullet names the conversion. When the managed content differed from the fresh render (in-place edits there), the bullet says the differences are not carried: recovery legitimately resets the managed region, but the drop is loud, so check whether any of those edits deserve a home outside the region or in the template.
  - appendix: anything unsplittable (no known marker shape in the repo's copy). The previous copy is preserved IN FULL below the fresh render's END marker under a recovery-appendix comment - `# repo-platform:recovery-appendix ...` in hash-comment files, `<!-- repo-platform:recovery-appendix ... -->` in markdown - and needs manual deduplication. Loud over lossy: an appendix is expected behavior, not a bug. The appendix content is LIVE in override-by-position formats (`.editorconfig`, CODEOWNERS, `.gitignore` all apply later entries over earlier ones), so the duplicated previous copy below the comment governs until you dedupe it. That is the conservative-correct behavior: the repo's previous rules keep winning, exactly as before the recovery.
- When the repo copy's markers are mangled, duplicated, or missing (and no retired shape matches either), the WHOLE previous copy is preserved below the fresh render's END marker under a `repo-platform:recovery-appendix` comment, with managed-region marker text dash-joined so validation still passes. Keep what is repository-owned, drop what the region above already covers, then delete the comment. The carry summary bullet says so - loud over lossy.
- A file whose copy equals the fresh render carries nothing: that is a no-op, not a loss. Emptied sides are still the repo's choice and ride through (the render's seed content is not resurrected over a deliberate deletion).

The carry summary lists only files the carry actually CHANGED - a file absent from the list was either untouched or never customized. Check every bullet against what you expect the repo's local content to be; the mandatory per-file review pass applies to recovery PRs doubly, never trust the carry blindly.

Everything else about the re-render:

- Edits to the MANAGED region of template-managed files are overwritten in the diff (that is the point of the recovery).
- Generated-once (`_skip_if_exists`) files survive, and copier deletes nothing; `.github/settings.yml` is restored outright, and a custom-license repo's own license survives untouched.
- Retired-file cleanup is skipped (no trustworthy old render to diff against), so stale template files may linger - remove them by hand if you spot them.
- The PR always stays manual-review; merging it re-records a resolvable `_commit`, and the next sync is a normal three-way update again.

## Repairing a recovery PR that lost local content

Recovery PRs generated BEFORE the carry step existed (and any future regression) show deletion-dominant diffs on the split files: `+0/-N` on AGENTS.md, SECURITY.md, CONTRIBUTING.md, LICENSE.md, `.gitattributes`, `.editorconfig`, `.github/CODEOWNERS`, or `.gitignore`. Do not merge one of those. Two fixes:

- Preferred: re-dispatch the recovery (same command as above). The branch is force-pushed fresh, so the new run - with the carry step - heals the open PR in place.
- Manual: re-seat the repo-owned sides on the automation branch. Read the base branch's copy and re-attach ONLY the content outside the managed region:

  ```bash
  git fetch origin
  git checkout -B automation/repo-platform origin/automation/repo-platform
  git show origin/main:AGENTS.md   # copy everything OUTSIDE the
                                   # BEGIN/END managed-region markers and
                                   # re-seat it on the branch: above-content
                                   # above BEGIN, tail content below END
  ```

  A base copy still in a RETIRED shape (not yet synced past the one-grammar change) splits differently: its repo-owned part is the block below the old `repo-platform:local-section` sentinel (or, for the old `.gitignore` shape, everything above the managed BEGIN marker) - re-seat that below the new END marker (tail) or above BEGIN (the old above-content). The WRONG restore is `git checkout origin/main -- AGENTS.md`: that reverts the whole file, managed region included, undoing the template update the PR exists to deliver. The correct mechanic is always re-seating the repo-owned content around the fresh managed region.

## Prevention

- Never hand-edit `_commit` in `.copier-answers.yml`, and never delete the file.
- Generate new repos from `gh:Vivswan/repo-platform` build refs, not from a local checkout.
