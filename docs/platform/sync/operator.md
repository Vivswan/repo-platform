---
order: 5
---

# The operator

This page is the operator's contract: the run that writes every managed repository as one row job each, what a row delivers, the dispatch that adds modules, and the two ways a branch is synced instead of the default branch. What that run keeps out of the public log for a private repository is [its own page](private-repositories.md).

[sync-repos.yml](../../../.github/workflows/sync-repos.yml) runs the writer against every managed repository: a `plan` job, then one `sync (row <i>)` job per row.

- **It wakes** on the Tuesday cron (the weekly heal), on a dispatch, or as the called leg of a merge's post-green run ([all-green.md](../../all-green.md#after-the-gate)).
- **The job shape is the redaction:** the public log carries row indexes and the vocabulary below, nothing else, and every detail lands in the target repository ([private repositories](private-repositories.md)).

| Step | Script | What it does |
| --- | --- | --- |
| plan: resolve the build | [sync/resolve_build.ts](../../../.github/scripts/sync/resolve_build.ts) | the commit the `stable` tag names, re-verified main history with a green `all-green` check ([build-provenance.md](../build-provenance.md)) and carrying `files.yml`; every row checks out exactly this commit |
| plan: discover and select | [fleet/discover_repos.ts](../../../.github/scripts/fleet/discover_repos.ts), [fleet/select_sync_repos.ts](../../../.github/scripts/fleet/select_sync_repos.ts) | the rows: the repositories the fleet token can push to that have adopted the platform, narrowed by the dispatch `repo` input or the called `repos` scope ([fleet/sync_scope.ts](../../../.github/scripts/fleet/sync_scope.ts)), written sorted to `$RUNNER_TEMP/rows.json`; the matrix: one `{row, key}` per row, the key opaque ([private repositories](private-repositories.md)); the log names the public slugs and counts the private ones |
| plan: print | [sync/verdict.ts](../../../.github/scripts/sync/verdict.ts) `plan` | `plan: <N> rows` |
| row 1: check out | actions/checkout | repo-platform, then the delivery commit the plan resolved under `build/` with its full history, whose dependencies are installed there (`bun install --cwd build`) so its writer renders with its own versions |
| row 2: resolve | [sync/resolve_row.ts](../../../.github/scripts/sync/resolve_row.ts) | one listing of the owner's writable repositories (the same call discovery makes, no re-selection); the row's key recomputed over it and the one repository carrying it taken, its name masked ([private repositories](private-repositories.md)); no such repository, or a dispatched branch one `git ls-remote` does not find: the step refuses, naming no repository |
| row 3: check out the target | [sync/checkout_target.ts](../../../.github/scripts/sync/checkout_target.ts) | a captured `git clone` with the fleet token (actions/checkout echoes git's diagnostics, which can quote target file text), at the dispatched branch when there is one; the token is stripped from the remote afterwards; `continue-on-error` |
| row 4: add modules | [sync/add_modules.ts](../../../.github/scripts/sync/add_modules.ts) | the dispatched `add_modules` names appended to the target's `.repo-platform.yml` ([adding modules](#adding-modules)); nothing on a run without the input; its log is `sync.log` until the writer's report replaces it; `continue-on-error` |
| row 5: migrate | the build's own [sync/migrate.ts](../../../.github/scripts/sync/migrate.ts), run from `build/` | every rung of the build's `migrations/` over the target ([Migrations](writer.md#migrations)); its log is `sync.log` until the writer's report replaces it; `continue-on-error` |
| row 6: write | the build's own [sync/writer/sync.ts](../../../.github/scripts/sync/writer/sync.ts), run from `build/` | the one writer step, so the commit the manifest records is the code that wrote the tree: report to `$RUNNER_TEMP/sync.log`, summary to `summary.json`, `continue-on-error` |
| row 7: deliver | [sync/deliver.ts](../../../.github/scripts/sync/deliver.ts) | a commit on `automation/repo-platform` and a PR whose body is the report, or another outcome ([delivering a row](#delivering-a-row)) |
| row 8: print | [sync/verdict.ts](../../../.github/scripts/sync/verdict.ts) `row` | one verdict line |

The row lines are the vocabulary the [new-project skill](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-new-project/SKILL.md#4-run-the-first-sync) and the [add-module skill](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-add-module/SKILL.md#2-review-the-report) read: `plan: <N> rows`, then one `row <i>: ...` line per row (`tests/sync/verdict.test.ts` pins the set).

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

The deliver step takes the writer's output: a commit and a PR in the target, one commit onto a dispatched branch with no PR, nothing when the tree already matches the build, or one failure issue.

- **What a delivery commits:** the manifest, the paths the writer's summary says it changed, the paths the rungs reported, and the registration on an `add_modules` run. Each is a literal pathspec (a `[` in a name is that character, not a class) forced past the target's own `.gitignore`. Nothing else is staged, and a path git cannot find fails the row.
- **The commit** lands on `automation/repo-platform`, pushed with a lease. On a branch dispatch it lands on the dispatched branch instead ([syncing a branch](#syncing-a-branch)).
- **The PR's body is the report.** Auto-merge is armed only when `hold` is false and the run's `manual` and `add_modules` inputs are both empty.
- **A refresh** re-bases the PR onto the checkout's default branch, and a fork's PR from a same-named branch is never taken for the sync's.
- **A tree that already matches the build** closes any open sync PR as obsolete: disarmed, closed with a one-line comment, its branch deleted.
- **A failed checkout, writer, or push** files or refreshes one `[repo-platform] sync failed` issue in the target with the log tails.
- **No recovery mode:** a broken target is re-synced by re-running the workflow, and the writer replaces platform files whole.
- **Every line** goes to `$RUNNER_TEMP/deliver.log`.

## Adding modules

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f add_modules=<a>,<b>
```

```text
add_modules: <a>, <b> go onto each row's .repo-platform.yml; no PR of this run is armed
row <i>: PR opened
```

The ordinary run, with one step more: row 4 appends the names the target's `.repo-platform.yml` lacks to its `modules` list, so the rungs and the writer read the new selection and the sync PR carries the registration edit with the module's files. The PR waits for a human: a module change is reviewed, so no PR of the run is armed, whatever the report says.

- **The edit is a splice,** one `- <name>` line per missing name after the last item (or before a flow list's `]`), and every other byte of the file stays. A name already selected stays where it is, and a repository selecting them all gets the ordinary sync.
- **The plan prints the admitted names once** and hands them to the rows as its `add_modules` output; the typed value stays off the log as `repo` does ([private repositories](private-repositories.md#where-the-model-stops)).
- **`repo` takes any scope** (a slug list, a visibility token, a `modules:` filter, `all`), so one dispatch rolls a module out across the fleet. `manual` beside it changes nothing; `branch` beside it is refused in the plan, since the branch's own registration is the edit.
- **Refused in the plan, before any repository is probed:** a name `files.yml` does not know, or an empty entry; the refusal counts the names and lists the roster.
- **Refused in the row, delivered as the writer's failure:** a registration the grammar refuses, or a `modules` list laid out in a way the splice cannot extend (a flow list with a trailing comma); the failure issue's writer log carries the line, and the way out is a branch carrying the edit ([syncing a branch](#syncing-a-branch)).
- **The writer judges the result:** a name the build at `stable` does not know yet (added to the platform since) is the writer's `unknown module(s)` refusal, filed in the target as any writer failure.
- **The PR body** opens with the dispatch's value, so the reviewer knows why the registration moved.

## Syncing a branch

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f branch=<branch>
```

```text
row <i>: branch pushed
```

**`branch pushed`** is a branch dispatch's clean row; the other lines mean the same on it.

The same row runs against that branch: the clone checks it out, the writer reads the registration on it, and the delivery commits the writer's output onto it as one commit (`chore: sync repo-platform build <sha>`). The push carries a lease on the commit the row cloned, so a commit pushed to the branch meanwhile fails the push instead of being overwritten.

- **No sync PR, no auto-merge, and no issue touched on a clean run:** the failure issue is the default-branch sync's. A failed checkout, writer, or push files it as any delivery failure does.
- **The report** the PR body would carry goes to the run's job summary, for a public repository; a private repository's summary says the report is withheld, and the commit on the branch is the record.
- **`repo` names exactly one repository** (no list, no `all`, no visibility token, no `modules:` filter), and `manual` and `add_modules` are refused beside `branch`: all three refuse in the plan job, before any repository is probed.
- **A branch the repository does not have,** or its default branch (a direct push there would pass the repository's PR gate; the plain dispatch syncs it through a PR), refuses in the row's resolve step, so the row prints `failed before the target was resolved`.
- **The branch name** rides the event payload as the repository name does, never step env, and never reaches the log; a public repository's job summary is the one place that names it.

### A module change on a pull request

A PR that changes a module selection carries its own files this way, declared and delivered together. The sync writes the module's DATA files (its workflows, starters, and toolchain pins) and the manifest stamp onto the PR's branch as one commit; CI itself needs nothing written, since ci.yml is the same file for every selection and fleet.yml's `plan` step reads the new list on the next run:

```text
PR edits modules: in .repo-platform.yml
  -> plan reads the registration against the module data at the `stable` commit's root
  -> validate-managed-files is red: it names each file the sync would write for the new selection, with the bytes
  -> gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<repo> -f branch=<pr-branch>
     (or the repo-platform:sync label on the PR, when the sync's whole diff touches no workflow file and holds nothing)
     one commit on the PR branch carries the files and the new manifest stamp
  -> with the label: approve the pushed head's run from the merge box (GitHub holds a repository-token push's run), or push a commit; the check is green
  -> review and merge the one PR
```

- **Why the PR is red first:** validate-managed-files runs the recorded commit's writer over a copy of the tree with the edited registration, so the module's missing files are findings naming each path with its bytes. The branch sync brings them, the manifest with them, and the check turns green.
- **A module the recorded commit does not know yet** (added to the platform after the repository's last sync) is the writer's `unknown module(s)` refusal in the check instead, with the same way out: the sync runs at `stable`, knows the module, and moves the judge.
- **The other red to expect:** a module whose fleet.yml jobs read a file the sync has not written yet (a toolchain module's jobs read its version pin, `.bun-version` for `bun`). It stays red until the branch sync writes that file onto the PR.
- **The one edit no sync can carry** is a selection that flips a recorded path's class (dropping `custom-license` while a mirror still targets `LICENSE.md`, say): the writer refuses the declaration that now conflicts, so no sync restamps the record until it is gone. Stage it: drop the mirror declaration first, let a sync drop its record, then change the modules.

## Syncing a branch by label

A human adds the `repo-platform:sync` label to a pull request; the repository's own managed [sync-branch.yml](../../../files/base/.github/workflows/sync-branch.yml) syncs the branch with the repository token, so nothing reaches the operator and no fleet token is involved. Nothing adds the label but a human.

```text
label added -> checks out the branch and the platform at `stable`
            -> the migrations, then the writer over the branch (the operator's row 5 and 6)
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

## This repository as a target

The sync targets this repository like any other: its [.repo-platform.yml](../../../.repo-platform.yml) registers it, and the writer keeps its root copies of the files it ships (`.editorconfig`, the `.gitignore` region, `LICENSE.md`, the `AGENTS.md` region, the rendered `.github/settings.yml`, the links) by sync PR, recorded in its own manifest.

- **Its `except`:** the paths whose file is this repository's own and cannot be the fleet's (its `ci.yml`, `dependabot.yml`, `.yamllint`, and the starters it does not take). A new starter and this repository's `except` for it take two PRs: the check judges the registration at the recorded commit ([manifest.md](manifest.md#judged-at-the-synced-commit)), which knows the path only after the sync that records it here.
- **Its CI** runs the [plan action](../../../actions/plan/action.yml) over the registration and then the [validate-managed-files action](../../../actions/validate-managed-files/action.yml) from the checkout, as fleet CI does: this checkout's action shell runs, the recorded commit's `check.ts` judges. A PR that changes `files/` stays green until this repository syncs itself.
- **Its `.yamllint`** ignores `files`, so the writer's templates (placeholder tokens, not YAML) are outside yamllint.
