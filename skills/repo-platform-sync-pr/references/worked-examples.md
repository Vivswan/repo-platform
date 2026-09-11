# Worked examples: report rows and their resolutions

Each entry is one row shape a sync PR's report can carry, the command that confirms it, and the resolution.

## 1. `replaced local edits` on `ci.yml`

Someone added a job directly to `.github/workflows/ci.yml`. The Written row reads `managed`, `replaced local edits`, and the Replaced local edits section shows the job as removed lines. Confirm with the diff between base and branch:

```bash
git fetch origin main automation/repo-platform
git diff origin/main...origin/automation/repo-platform -- .github/workflows/ci.yml
```

Resolution: expected. `ci.yml` is the same file in every repository. Move the job into `checks.yml` (it runs inside the all-green gate) or `post-green.yml` (green-gated work on main), commit on the PR branch, merge.

## 2. `region removed` retirement of a split file

The platform retired a split file (`.github/SECURITY.md` in the cutover) and the repo had written below its END marker. The region still matched the recorded hash, so the Retired row reads `region removed`: the markers and the platform's region went, your text stayed as a plain file, and the PR holds once.

Resolution: the file is now yours. Keep it or delete it; the record left with the region, so no row returns for it. A region that no longer matches the recorded hash reads `held` instead, and that row returns every sync until the file is gone.

## 3. A mirror declaration the writer cannot honour

`.repo-platform.yml` declares `mirrors: [{source: LICENSE.md, targets: ["docs/**/LICENSE.md"]}]`. The `plan` job of fleet CI rejects `**` on the PR that adds it; a declaration that lands anyway, or one only the checkout can refuse (a symbolic link where the copy would land), fails the sync: no PR, and the `[repo-platform] sync failed` issue's writer log reads `.repo-platform.yml: mirrors: source 'LICENSE.md', target 'docs/**/LICENSE.md': the pattern uses '**'`.

Resolution: single-segment globs only: `docs/*/LICENSE.md`. Fix the declaration in an ordinary PR, dispatch the sync again; it writes the copies and closes the issue.

## 4. Registration note: an unknown module

`modules:` lists `issue-forms`. The Registration notes section names it as dropped; the PR holds; the module's files were not written.

Resolution: the name is `issue-templates`. Fix `.repo-platform.yml`, merge, dispatch the sync again.

## 5. A first-sync `unchanged` starter at a path the repo already had

An adopted repository already carried `.github/workflows/checks.yml`. Its Written row reads `starter`, `unchanged`: a starter is written only when absent, so the repo's file stays untouched.

Resolution: check the kept file exposes what `ci.yml` calls (`on: workflow_call` with no inputs for `checks.yml`; a `sha` input for `post-green.yml`; `tag` for `update-release.yml`; `pr_number` and `head_branch` for `update-release-pr.yml`). A hook lacking its input fails the calling job on the first run.

## 6. A split file's diff reaches outside the markers

The `.gitignore` diff shows lines changing below the END marker. The writer never touches the tail, so this is a sync bug.

Resolution: do not merge. Report it on Vivswan/repo-platform with the PR link; the next run rewrites the branch once fixed.
