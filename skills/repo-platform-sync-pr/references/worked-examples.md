# Worked examples: report rows and their resolutions

Each entry is one row shape a sync PR's report can carry, the command that confirms it, and the resolution.

## 1. `replaced local edits` on `ci.yml`

Someone added a job directly to `.github/workflows/ci.yml`. The Written row reads `managed`, `replaced local edits`, and the Replaced local edits section shows the job as removed lines. Confirm with the diff between base and branch:

```bash
git fetch origin main automation/repo-platform
git diff origin/main...origin/automation/repo-platform -- .github/workflows/ci.yml
```

Resolution: expected. `ci.yml` is the same file in every repository. Move the job into `checks.yml` (it runs inside the all-green gate) or `post-green.yml` (green-gated work on main), commit on the PR branch, merge.

## 2. `held` retirement of a split file

The platform retired a split file (`.github/SECURITY.md` in the cutover) and the repo had written below its END marker. The Retired row reads `held` with a detail naming repository-owned content outside the region.

Resolution: the file is now yours. Delete the platform's region and keep your text, or delete the file; the row returns on every sync until the file is gone.

## 3. `refused` mirror

`.repo-platform.yml` declares `mirrors: [{source: LICENSE.md, targets: ["docs/**/LICENSE.md"]}]`. The Mirrors row reads `refused` because `**` is not accepted; the PR holds.

Resolution: single-segment globs only: `docs/*/LICENSE.md`. Fix the declaration in an ordinary PR; the next sync writes the copies.

## 4. Registration note: an unknown module

`modules:` lists `issue-forms`. The Registration notes section names it as dropped; the PR holds; the module's files were not written.

Resolution: the name is `issue-templates`. Fix `.repo-platform.yml`, merge, dispatch the sync again.

## 5. A first-sync `unchanged` starter at a path the repo already had

An adopted repository already carried `.github/workflows/checks.yml`. Its Written row reads `starter`, `unchanged`: a starter is written only when absent, so the repo's file stays untouched.

Resolution: check the kept file exposes what `ci.yml` calls (`on: workflow_call` with no inputs for `checks.yml`; a `sha` input for `post-green.yml`; `tag` for `update-release.yml`; `pr_number` and `head_branch` for `update-release-pr.yml`). A hook lacking its input fails the calling job on the first run.

## 6. A split file's diff reaches outside the markers

The `.gitignore` diff shows lines changing below the END marker. The writer never touches the tail, so this is a sync bug.

Resolution: do not merge. Report it on Vivswan/repo-platform with the PR link; the next run rewrites the branch once fixed.
