---
order: 250
group: Fleet operations
---

# Build provenance

How the `stable` tag gets moved, how a sync verifies the commit it names before consuming it, and which trusts remain. This document states the contract; each invariant is owned by exactly one script, named per section, whose header carries only what the code alone cannot show.

| Question | Owner |
| --- | --- |
| When does a move happen, and what gates it? | [post-green/move_stable.ts](../.github/scripts/post-green/move_stable.ts) |
| How does a sync verify the commit before consuming it? | [sync/resolve_build.ts](../.github/scripts/sync/resolve_build.ts) |
| Which workflows drive the flow? | [ci.yml](../.github/workflows/ci.yml) (the [all-green gate](all-green.md) + the post-green caller), [post-green.yml](../.github/workflows/post-green.yml) (the move, on the call and on a dispatch) |

## The delivery ref is a tag on main

`refs/tags/stable` names a commit on `main` whose own CI run passed. Every fleet `uses:` pins it (`Vivswan/repo-platform/actions/<name>@stable`, `.../.github/workflows/<name>.yml@stable`) and the sync operator checks it out, so the fleet reads main's own committed tree at that commit:

| What the fleet reads | Where it sits at the commit | Who reads it |
| --- | --- | --- |
| `files.yml` and `files/` | the repository root | the sync writer ([sync.md](sync.md)), the plan action (`files.yml`'s modules block, and the settings layers under `files/` for the labels no tracking stream may reuse: [actions/plan/reserved_labels.ts](../actions/plan/reserved_labels.ts)), validate-managed-files |
| `actions/<name>/` | the repository root; each action installs its own pinned dependencies at run time | every managed workflow's `uses:` |
| `.github/workflows/<name>.yml` with a `workflow_call` trigger | the repository root | every managed workflow's reusable-workflow `uses:` (the `fleet-refs-ride-stable` ssot rule pins each fleet pin to a callable workflow) |

Nothing the fleet reads is generated: what a `uses:` fetches is what CI judged. Two constraints follow for every path on `main`: a `uses:` ref downloads the whole repository tarball at the tag, so no path may carry a name extraction cannot write (conditional landing is `files.yml`'s `when` clauses, never a filename), and a composite action must resolve from its own directory alone, since nothing installs the repository's root dependencies on the caller's runner.

Every self pin resolves: the `delivery-pin-stems` ssot rule ([delivery_pins.ts](../scripts/check/ssot/delivery_pins.ts)) checks each `uses: <owner>/repo-platform/<stem>@<ref>` in the writer's sources, this repository's workflows and action manifests, and the docs' examples against the checkout, whatever the ref, so a renamed or deleted action fails CI here instead of the next fleet run.

## Who can write `refs/tags/stable`?

| Writer | When | What gates the write |
| --- | --- | --- |
| post-green.yml's move-stable job, called | After the `all-green` gate passes on a push to main | ci.yml's post-green job (needs-ordered behind the gate, same run) releases it, and move_stable.ts re-verifies main history and the check at the commit before the push. |
| post-green.yml's move-stable job, dispatched | A manual `workflow_dispatch` naming a green main commit's sha (the self-heal) | move_stable.ts's verification - main history, completed successful `all-green` - is the SOLE gate there. |
| Anyone with push access, out of band | Any time | Nothing at write time: the `stable-tag` ruleset ([.github/settings.local.yml](../.github/settings.local.yml)) blocks deletion only. Sync consumption re-verifies below; `uses:` execution trusts the ref (the residuals table). |

The ruleset blocks deletion only because git classifies every update of an existing tag as a forced update, so a `non_fast_forward` or `update` rule would block the mover itself; rollback protection is the mover's ancestry skip plus the lease.

## The delivery flow: push to move

A change merges to main as commit S. What happens, in order:

| Step | Actor | What happens |
| --- | --- | --- |
| 1. The gating jobs finish | ci.yml's `all-green` job | Judges every needed result; its own check run IS the `all-green` check ([all-green.md](all-green.md)). |
| 2. Gate green on a main push | ci.yml's post-green job | Calls [post-green.yml](../.github/workflows/post-green.yml) with `github.sha` (same run - the judged commit by construction). |
| 3. Move | post-green.yml's move-stable job | [move_stable.ts](../.github/scripts/post-green/move_stable.ts) verifies S is main history with a green check, reads where the tag sits, and moves it to S with a lease push. |
| 4. Deploy this repository's docs | ci.yml's `site` job, ordered behind post-green | The site module's leg, carried by hand in this repository's ci.yml: calls reusable-site.yml with `github.sha` after the mover, so a green move's theme is what `@stable` serves the build ([all-green.md](all-green.md#after-the-gate)). Gated on the all-green result alone under `!cancelled()`: a red or skipped post-green never holds the site back (the site then deploys from the tag as it stands), and its own failure shows as its own red job. |

The commit moved to is always SOURCE_SHA - the judged run's own commit on the call, the operator's sha input on a dispatch - never a read of origin/main, which can already be a newer, even red, commit (move_stable.ts's header owns this discipline).

A missing move (a failed or evicted post-green run after a green gate) heals two ways: the next push to main moves the tag to the newer commit, or an operator dispatches post-green.yml with the green commit's sha. Until the heal, a sync copies from the commit the tag names as it stands (the residuals table; a sync PR, when one opens, records that commit). Anything without a green `all-green` check is not deliverable - re-run that commit's CI first (the gate job posts the check), then dispatch.

## Newest-green wins, one mover at a time

- **One lane.** Every workflow mover serializes in the repo-scoped concurrency lane `stable-tag-move`, held by post-green.yml's move-stable job as a literal string: a called run and a dispatched run are runs of DIFFERENT workflows, and a group derived from `github.workflow` would silently split the lane between them (post-green.yml's header).
- **Ancestry skip.** A mover whose sha the tag already names, or has moved past (the tag's commit descends from the sha), moves nothing and exits green: a re-run of an older commit's legs after a newer main commit moved the tag never rolls the fleet back.
- **The lease.** The push is `--force-with-lease` naming the value just read (the tag object for an annotated tag, an empty lease when the tag is absent), so two movers racing leaves the loser red and the tag untouched.
- **The output.** `previous`, the commit the tag named before a move (empty when nothing moved), is the `read-directives` leg's base ahead of the push's `before`. On a call that leg reads on every mover result: a newer run's range starts after its own base, which can be this very commit, so only this commit's run is sure to read it ([all-green.md](all-green.md#after-the-gate)).
- **The credential.** The push uses the run's `GITHUB_TOKEN` with `contents: write` (ci.yml's post-green job grants that ceiling), the way GitHub's own actions/publish-action moves an action's major tag with the default token.
- **The open question, settled by the first live move.** The docs list the ref-update endpoints as possibly needing the `workflows` permission too, with no stated condition, and no official page says whether a ref update to a commit already on the server can trip the workflow-file refusal. If GitHub refuses the push, the fallback is the `REPO_PLATFORM_TOKEN` the workflow already receives for the publisher, passed as the mover checkout's `token`, with no new secret.

## Provenance is the commit itself

The tag names a main commit whose own CI run passed, so there is no generated tree to prove and no stamp to parse. Two facts anchor everything, verified at the move and re-verified at every sync ([sync/resolve_build.ts](../.github/scripts/sync/resolve_build.ts)), both hard failures:

| # | Check | What it catches |
| --- | --- | --- |
| 1 | The commit is `main` history (`git merge-base --is-ancestor`, through [shared/git_yes_no.ts](../.github/scripts/shared/git_yes_no.ts), so an errored look is fatal, never a "no"). | A tag pointed at a PR head, a side branch, or a foreign commit. |
| 2 | The commit carries a completed successful `all-green` check run ([shared/all_green.ts](../.github/scripts/shared/all_green.ts)). | A red or unjudged commit. |

The sync also requires `files.yml` at the commit's root, since a commit without the writer's data file has nothing to sync from, and resolves the tag through `^{commit}` so a hand-made annotated tag names its commit, never the tag object.

The recorded delivery is the full 40-hex sha of that main commit: the writer takes it from the operator's `--build` argument (the commit resolve_build.ts resolved for the whole run) and writes it into the manifest's own entry ([sync.md](sync.md#the-manifest)), so every repository names the exact commit its files came from. Old delivery commits stay reachable forever: they are main history.

## The build branch, until its deletion

The same post-green run still publishes the orphan `build` branch beside the tag, behind a green move (the directives read prefers its stamps to the mover's base, so a red move must not see the stamps advance): [build-branches/publish.ts](../.github/scripts/build-branches/publish.ts) assembles the judged commit's tree with [branch_tree.ts](../.github/scripts/build-branches/branch_tree.ts) (`files.yml` and `files/`, `actions/`, the fleet-facing reusable workflows, a derived `reserved-labels.yml`) and chains a stamped commit onto the branch tip in the `build-branches-publish` lane, with [sync/verify_build_provenance.ts](../.github/scripts/sync/verify_build_provenance.ts) as the tree proof a consumer would run. No source under `files/` pins the branch and no sync reads it; the only readers left are the starters already written into repositories (nightly and fuzzer workflows, never rewritten by the sync), which keep their `@build` pin until a migration moves it. The directives leg's range read ([fleet/judged_range.ts](../.github/scripts/fleet/judged_range.ts)) still takes its stamps as the base ahead of the mover's `previous`. Deleting the publisher, the branch, and the stamp machinery is the next change.

## A new action input lands as a stack

A managed workflow (`files/<module>/.github/workflows/<name>.yml` and this repository's root twin of it) calls platform actions at the delivery ref, and the root twin is this repository's own check of that workflow. A workflow PR that feeds an action an input not yet at the delivery ref reds itself, whether the PR adds the input or is stacked on the PR that does: its check runs the action's copy at the delivery ref.

1. Land the action change alone: its own PR against main, so the post-green run carries the new input to the delivery ref.
2. Stack the workflow PR on the action branch while both are open. Once the action PR merges, rebase the workflow branch onto main with `--onto main <old action tip>` and retarget the PR: the squash made a new commit, so a plain retarget keeps the action commits in the workflow PR's diff.
3. Wait for the action merge's post-green run to move the delivery ref, then re-run the workflow PR's check and merge: a push before the move runs the old copy again, and the move itself starts no PR run.

Example: the pr-title workflow PR feeding validate-commit-names a new `title` input, stacked on the action PR before that PR merged; its own `pr-title` check ran the delivery-ref copy, which ignored the input and judged a commit range in a checkout-less job (`fatal: not a git repository`).

## Residuals

| Residual | Why it stands | What bounds it |
| --- | --- | --- |
| `uses: ...@stable` execution trusts the ref. | A user-repo ruleset cannot restrict other writers to one workflow; it blocks deletion only. | Sync consumption re-verifies main history and the green check at the commit; the tag can only ever name a commit that exists on the server, and repo-platform's own CI gates every commit on `main` (an out-of-band move to a red or off-main commit bypasses the fleet's `uses:` execution, the ref-trust residual in full). |
| Actor provenance is advisory. | Nothing records which run moved the tag; a lightweight tag carries no message. | The check at the commit is the anchor, not the mover's identity. |
| A sync copies from the commit the tag names as it stands: a hand dispatch seconds after a merge, or the Tuesday cron firing while a merge shortly before it is still in CI, copies the previous commit, as does any sync while a move is missing. | No freshness wait exists. The post-green call is needs-ordered behind the mover in the same run, so only a sync that wakes on its own (dispatch or cron) can meet the lag. | resolve_build.ts runs the green gate and the ancestry check on that commit, and a sync PR, when one opens, records the commit it copied; the next sync (the weekly cron, or a `[fleet-sync: public]` directive on the next merge - [all-green.md](all-green.md#after-the-gate)) consumes the move once it lands, and a move that never landed is healed by the next push or a dispatch with the green commit's sha. |
