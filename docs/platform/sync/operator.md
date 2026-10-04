---
order: 5
---

# The operator

This page is the operator's contract: the run that writes every managed repository as one row job each, what a row delivers, and the two ways a branch is synced instead of the default branch. What that run keeps out of the public log for a private repository is [its own page](private-repositories.md).

[sync-repos.yml](../../../.github/workflows/sync-repos.yml) runs the writer against every managed repository: a `plan` job, then one `sync (row <i>)` job per row.

- **It wakes** on the Tuesday cron (the weekly heal), on a dispatch, or as the called leg of a merge's post-green run ([all-green.md](../../all-green.md#after-the-gate)).
- **The job shape is the redaction:** the public log carries row indexes and the vocabulary below, nothing else, and every detail lands in the target repository ([private repositories](private-repositories.md)).

| Step | Script | What it does |
| --- | --- | --- |
| plan: resolve the build | [sync/resolve_build.ts](../../../.github/scripts/sync/resolve_build.ts) | the commit the `stable` tag names, re-verified main history with a green `all-green` check ([build-provenance.md](../../build-provenance.md)) and carrying `files.yml`; every row checks out exactly this commit |
| plan: discover and select | [fleet/discover_repos.ts](../../../.github/scripts/fleet/discover_repos.ts), [fleet/select_sync_repos.ts](../../../.github/scripts/fleet/select_sync_repos.ts) | the rows: the repositories the fleet token can push to that have adopted the platform, narrowed by the dispatch `repo` input or the called `repos` scope ([fleet/sync_scope.ts](../../../.github/scripts/fleet/sync_scope.ts)), written sorted to `$RUNNER_TEMP/rows.json`; the matrix: one `{row, key}` per row, the key opaque ([private repositories](private-repositories.md)); the log names the public slugs and counts the private ones |
| plan: print | [sync/verdict.ts](../../../.github/scripts/sync/verdict.ts) `plan` | `plan: <N> rows` |
| row 1: check out | actions/checkout | repo-platform, then the delivery commit the plan resolved under `build/`, whose dependencies are installed there (`bun install --cwd build`) so its writer renders with its own versions |
| row 2: resolve | [sync/resolve_row.ts](../../../.github/scripts/sync/resolve_row.ts) | one listing of the owner's writable repositories (the same call discovery makes, no re-selection); the row's key recomputed over it and the one repository carrying it taken, its name masked ([private repositories](private-repositories.md)); no such repository, or a dispatched branch one `git ls-remote` does not find: the step refuses, naming no repository |
| row 3: check out the target | [sync/checkout_target.ts](../../../.github/scripts/sync/checkout_target.ts) | a captured `git clone` with the fleet token (actions/checkout echoes git's diagnostics, which can quote target file text), at the dispatched branch when there is one; the token is stripped from the remote afterwards; `continue-on-error` |
| row 4: migrate | the build's own [sync/migrate.ts](../../../.github/scripts/sync/migrate.ts), run from `build/` | every rung of the build's `migrations/` over the target ([Migrations](writer.md#migrations)); its log is `sync.log` until the writer's report replaces it; `continue-on-error` |
| row 5: write | the build's own [sync/writer/sync.ts](../../../.github/scripts/sync/writer/sync.ts), run from `build/` | the one writer step, so the commit the manifest records is the code that wrote the tree: report to `$RUNNER_TEMP/sync.log`, summary to `summary.json`, `continue-on-error` |
| row 6: deliver | [sync/deliver.ts](../../../.github/scripts/sync/deliver.ts) | a commit on `automation/repo-platform` and a PR whose body is the report, or another outcome ([delivering a row](#delivering-a-row)) |
| row 7: print | [sync/verdict.ts](../../../.github/scripts/sync/verdict.ts) `row` | one verdict line |

The vocabulary, complete (`tests/sync/verdict.test.ts` pins it):

```text
plan: <N> rows
row <i>: unchanged
row <i>: PR opened
row <i>: PR refreshed
row <i>: branch pushed
row <i>: failed, report filed in the target repository
row <i>: failed before the target was resolved; re-run the workflow
```

- **A row is red only when a step before or at the resolve failed** (the install, the build checkout, the listing, the resolve itself). The printer then prints the unresolved line, and the failed step's exit status is the whole public signal. The plan job listed the same repositories moments earlier, so re-running the workflow is the remedy.
- **From the checkout on,** the steps continue on error and the failure is delivered to the target; the row stays green with its verdict line. The one exception is a target that cannot take the failure report (no Issues grant): that row prints nothing and is red.
- **Where the detail is:** a delivered row's PR body; a failed row's issue (the tails of the checkout, writer, and delivery logs).
- **A row is bound to its repository by the key of its slug,** not by index, and the listing is the check, not a re-selection. No count or order change moves a row onto another repository.

| A repository that, mid-run, ... | Its row |
| --- | --- |
| the listing no longer names (a private one revoked from the grant, any one renamed) | has no listed slug carrying the key, so the row refuses (red, `re-run the workflow`) |
| is a public one revoked | stays listed (the listing reports the user's permission, not the token's grant) and its row fails where the token first writes |
| un-adopted | is still listed, so its row runs and the writer's failure on the missing registration is delivered to it (the next plan drops it) |
| adopted | has no row until the next run |

The residual is a slug another writable repository takes within the run: the row syncs that repository as the plan's.

## Delivering a row

Row 6 delivers the writer's output: a commit and a PR in the target, one commit onto a dispatched branch with no PR, nothing when the tree already matches the build, or one failure issue.

- **What a delivery commits:** the manifest, the paths the writer's summary says it changed, and the paths the rungs reported. Each is a literal pathspec (a `[` in a name is that character, not a class) forced past the target's own `.gitignore`. Nothing else is staged, and a path git cannot find fails the row.
- **The commit** lands on `automation/repo-platform`, pushed with a lease. On a branch dispatch it lands on the dispatched branch instead ([syncing a branch](#syncing-a-branch)).
- **The PR's body is the report.** Auto-merge is armed only when `hold` is false and the run's `manual` input is false.
- **A refresh** re-bases the PR onto the checkout's default branch, and a fork's PR from a same-named branch is never taken for the sync's.
- **A tree that already matches the build** closes any open sync PR as obsolete: disarmed, closed with a one-line comment, its branch deleted.
- **A failed checkout, writer, or push** files or refreshes one `[repo-platform] sync failed` issue in the target with the log tails.
- **Every line** goes to `$RUNNER_TEMP/deliver.log`.

## Syncing a branch

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f branch=<branch>
```

```text
row <i>: branch pushed
```

**`branch pushed`** is a branch dispatch's clean row; the other lines mean the same on it.

The same row runs against that branch: the clone checks it out, the writer reads the registration on it, and the delivery commits the writer's output onto it as one commit (`chore: sync repo-platform build <sha>`). The push carries a lease on the commit the row cloned, so a commit pushed to the branch meanwhile fails the push instead of being overwritten.

A PR that changes a module selection carries its own files this way, declared and delivered together ([new-repo.md](../../new-repo.md#changing-the-module-selection)).

- **No sync PR, no auto-merge, and no issue touched on a clean run:** the failure issue is the default-branch sync's. A failed checkout, writer, or push files it as any delivery failure does.
- **The report** the PR body would carry goes to the run's job summary, for a public repository; a private repository's summary says the report is withheld, and the commit on the branch is the record.
- **`repo` names exactly one repository** (no list, no `all`, no visibility token, no `modules:` filter), and `manual` is refused beside `branch`: both refuse in the plan job, before any repository is probed.
- **A branch the repository does not have,** or its default branch (a direct push there would pass the repository's PR gate; the plain dispatch syncs it through a PR), refuses in the row's resolve step, so the row prints `failed before the target was resolved`.
- **The branch name** rides the event payload as the repository name does, never step env, and never reaches the log; a public repository's job summary is the one place that names it.

## Syncing a branch by label

A human adds the `repo-platform:sync` label to a pull request; the repository's own managed [sync-branch.yml](../../../files/base/.github/workflows/sync-branch.yml) syncs the branch with the repository token, so nothing reaches the operator and no fleet token is involved. Nothing adds the label but a human.

```text
label added -> checks out the branch and the platform at `stable`
            -> the migrations, then the writer over the branch (the operator's row 4 and 5)
            -> the delivery step takes the label off
            -> one commit onto the branch, pushed with a lease on the commit it checked out
            -> one sticky comment on the pull request carrying the report
```

| Outcome | Job | Comment says |
| --- | --- | --- |
| files written | green | pushed as `<commit>`; approve the head's held pull_request run from the merge box, or push a commit; then the report |
| tree already matches | green | nothing pushed |
| the writer holds (a replaced local edit, a registration note, a link in a managed file's place) | red, nothing pushed | the report with its Review section: a hold is a human's call, and the branch is a human's |
| the sync changes a file under `.github/workflows/` | red, nothing pushed | the paths, and the operator's branch dispatch as the way: the repository token cannot create or update a workflow file |
| a rung or the writer failed | red, nothing pushed | the log tail |
| a written path git cannot stage | red, nothing pushed | no comment; the job log carries git's line naming the path |
| the push refused (a commit reached the branch meanwhile, a rule the token cannot meet) | red | git's message; add the label again once the branch is where you want it |

- **Same-repository branches only:** a fork's pull request skips the job at zero billed minutes (its token could not push), and so does any other label.
- **The pushed head's checks wait for a human:** GitHub holds the `pull_request` run a repository-token push creates for approval, so approve it from the merge box (or push a commit of your own) to run them.
- **The platform dispatches nothing:** a `workflow_dispatch` run of `ci.yml` would post `all-green` on the head while skipping the pull-request-only legs, and the `pr-title` module's check never posts on one, a weaker gate than the held run.
- **What is committed:** exactly what an operator delivery commits ([delivering a row](#delivering-a-row)).
- **What the label covers:** toolchain pins, the rendered settings, the `.gitignore` and `AGENTS.md` regions, the manifest stamp, and the validator's drift findings on any file outside `.github/workflows/`. A change under `.github/workflows/` stays with the operator's branch dispatch.
- **The job holds** `contents: write` and `pull-requests: write` (the comment and the label), nothing else, with no secret.
- **A run that goes red before the delivery step** (a checkout or the install) leaves the label on: remove it and add it again to retry.
- **The label is declared** in the baseline settings layer ([settings.md](../../settings.md#what-the-baseline-contains)); the validator's red comment names it as the remedy for managed drift.
