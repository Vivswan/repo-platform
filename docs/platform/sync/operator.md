---
order: 5
---

# The operator

This page is the operator's contract: the run that writes every managed repository as one row job each, what a row delivers, the dispatch that adds modules, and the two ways a branch is synced instead of the default branch. What that run keeps out of the public log for a private repository is [its own page](private-repositories.md).

[sync-repos.yml](../../../.github/workflows/sync-repos.yml) runs the writer against every managed repository: a `plan` job, then one `sync (row <i>)` job per row.

- **It wakes** on the Tuesday cron (the weekly heal), on a dispatch, or as the called leg of a merge's post-green run ([all-green.md](../../all-green.md#after-the-gate)).
- **The job shape is the redaction:** the public log carries row indexes and the vocabulary below, nothing else, and every detail lands in the target repository ([private repositories](private-repositories.md)).

The steps are [sync-repos.yml](../../../.github/workflows/sync-repos.yml)'s, each a script under [.github/scripts/](../../../.github/scripts/) (`fleet/` for discovery and selection, `sync/` for the rest) or a checkout. The plan resolves the build ([build-provenance.md](../build-provenance.md)) and selects the rows; each row checks out the build and the target, adds modules, migrates, writes, delivers, and prints its verdict.

The build's own writer and migration runner run from its checkout, so the commit the manifest records is the code that wrote the tree.

The row lines are the vocabulary the [new-project skill](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-new-project/SKILL.md#4-run-the-first-sync) and the [add-module skill](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-add-module/SKILL.md#2-review-the-report) read: `plan: <N> rows`, then one `row <i>: ...` line per row (`tests/sync/verdict.test.ts` pins the set).

- **A row is red only when a step before or at the resolve failed** (the install, the build checkout, the listing, the resolve itself). The printer then prints the unresolved line, and the failed step's exit status is the whole public signal. The plan job listed the same repositories moments earlier, so re-running the workflow is the remedy.
- **From the checkout on,** the steps continue on error and the failure is delivered to the target; the row stays green with its verdict line. The one exception is a target that cannot take the failure report (no Issues grant): that row prints nothing and is red.
- **Where the detail is:** a delivered row's PR body; a failed row's issue (the tails of the checkout, writer, and delivery logs).
- **A row is bound to its repository by the key of its slug,** not by index, and the listing is the check, not a re-selection. No count or order change moves a row onto another repository.

| A repository that, mid-run, ...                                                     | Its row                                                                                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| the listing no longer names (a private one revoked from the grant, any one renamed) | has no listed slug carrying the key, so the row refuses (red, `re-run the workflow`)                                              |
| is a public one revoked                                                             | stays listed (the listing reports the user's permission, not the token's grant) and its row fails where the token first writes    |
| un-adopted                                                                          | is still listed, so its row runs and the writer's failure on the missing registration is delivered to it (the next plan drops it) |
| adopted                                                                             | has no row until the next run                                                                                                     |

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

The ordinary run, with one step more: the add-modules step appends the names the target's `.repo-platform.yml` lacks to its `modules` list, so the rungs and the writer read the new selection and the sync PR carries the registration edit with the module's files. The PR waits for a human: a module change is reviewed, so no PR of the run is armed, whatever the report says.

- **The edit is a splice,** one `- <name>` line per missing name after the last item (or before a flow list's `]`), and every other byte of the file stays. A name already selected stays where it is, and a repository selecting them all gets the ordinary sync.
- **The plan prints the admitted names once** and hands them to the rows as its `add_modules` output; the typed value stays off the log as `repo` does ([private repositories](private-repositories.md#where-the-model-stops)).
- **`repo` takes any scope** (a slug list, a visibility token, a `modules:` filter, `all`), so one dispatch rolls a module out across the fleet. `manual` beside it changes nothing; `branch` beside it is refused in the plan, since the branch's own registration is the edit.
- **Refusals name themselves:** an unknown module or an empty entry in the plan, before any repository is probed; a registration the grammar refuses, or a `modules` list the splice cannot extend, in the row, delivered as the writer's failure, with a branch carrying the edit as the way out ([syncing a branch](#syncing-a-branch)).
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
- **The default branch is refused:** a direct push there would pass the repository's PR gate, and the plain dispatch syncs it through a PR.
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
            -> the migrations, then the writer over the branch (the operator's migrate and write steps)
            -> the delivery step takes the label off
            -> one commit onto the branch, pushed with a lease on the commit it checked out
            -> one sticky comment on the pull request carrying the report
```

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
