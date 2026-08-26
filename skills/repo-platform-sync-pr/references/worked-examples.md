# Worked examples from live sync incidents

Each pattern was seen in production; each entry carries the command that diagnosed it and its resolution.

## 1. Recovery PR gutted repository-local sections

A `recover=recopy` re-render arrived with local content stripped: `copilot-env` PR #103 showed `AGENTS.md +0/-200`; `skills` PR #22 dropped 79 local AGENTS.md lines plus 7 lines from the `.gitignore` REPOSITORY LOCAL section. Diagnosed by the per-file stats pass:

```bash
gh pr view <number> --json files --jq '.files[]|[.path,.additions,.deletions]|@tsv'
# AGENTS.md  0  200   <- deletion-dominant on a local-section file
```

Resolution: those PRs predate the recovery carry step; recoveries now splice local content back (kept-whole, tail-appended, or a marked recovery appendix) and list each carried file's disposition in the PR body's carry summary, so this diff shape should not recur. If it ever does, do not merge. Preferred fix: re-dispatch the recovery - the force-pushed branch heals the open PR in place. Manual fix: on the automation branch, read the base copy with `git show origin/main:AGENTS.md` and re-append ONLY the block below the `repo-platform:local-section` line (for `.gitignore`, the lines inside BEGIN/END REPOSITORY LOCAL). Never `git checkout origin/main -- AGENTS.md`: that reverts the managed half too, undoing the update the PR exists to deliver. Details: [recovery.md](recovery.md).

## 2. Hand-edits to fully-managed files reverted by sync

A sync PR "undoes" edits someone made directly to ci.yml, dependabot.yml, the managed half of AGENTS.md, or another fully-managed file. Diagnosed by diffing the file between base and automation branch:

```bash
git fetch origin main automation/repo-platform-staging
git diff origin/main...origin/automation/repo-platform-staging -- .github/workflows/ci.yml
```

Resolution: expected - overlapping edits to template-owned files lose to the template. Move the content to where it is owned: below the `repo-platform:local-section` marker, into the `.gitignore` REPOSITORY LOCAL section, or into a repo-owned file (CI jobs go in checks.yml). If the change belongs to every repo, change the template in repo-platform instead.

## 3. True three-way conflicts in a normal sync PR

Local edits overlapped template changes in a non-split file; the PR body lists dropped hunks per file. Diagnosed by reading the body's conflict summary:

```bash
gh pr view <number> --json body --jq .body | grep -A20 'Conflict'
```

Resolution: reset to the remote automation branch (`git checkout -B automation/repo-platform-<channel> origin/automation/repo-platform-<channel>`), restore the hunks that should stay (in their owned location, per the file-class table), push, merge when green. Resolve promptly: the next scheduled sync force-pushes the branch and replaces parked commits.

## 4. Repo-owned checks asserting content inside managed files

A repo's own test (e.g. a smoke test asserting a specific AGENTS.md section) went red on a sync PR because the template rewrote the managed half it was asserting on. Diagnosed from the failing check's log:

```bash
gh pr checks <number>
gh run view <run-id> --log-failed
```

Resolution: point such assertions at local-section or repo-owned content only; the managed half can change on any sync and is not the repo's to pin.
