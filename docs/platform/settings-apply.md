---
order: 265
---

# The settings apply

This page is the central run that applies every managed repository's rendered `.github/settings.yml`: the dispatch scope, the green-commit gate, newest wins, the plan and apply jobs, selection, private targets, check mode, and the token. The settings model (the layers, the dialect, what the apply does to the rendered document) and the run's three entries are [settings.md](../settings.md).

## The dispatch scope

**The `-f repo=` scope** is the sync's grammar ([the README's `repo=` table](../../README.md#shipping-a-change)); an entry naming no discovered fleet repository or no module of `files.yml` fails the run before any row exists. What admits each discovered repository the scope names is [Selection](#selection).

## The green-commit gate

Every run, on all three entries ([when it runs](../settings.md#when-it-runs)), applies only from a GREEN commit ([fleet/require_green_commit.ts](../../.github/scripts/fleet/require_green_commit.ts), the same [all-green predicate](../all-green.md#consuming-the-gate) the tag mover and the sync enforce). Each job has one checkout with no `ref:`, so the selector's and the resolver's code is the judged commit's.

| Entry                     | The gate                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Post-green call           | the sha input must be the run's own judged commit, read through the tag mover's bounded all-green poll (shared/all_green.ts) |
| Dispatch and nightly heal | waits, bounded, for the tip's all-green check and fails closed on red or none                                                |

- **Post-green call:** the caller is needs-ordered behind the gate in the same run, so a verdict still pending at the bound means the call came from somewhere else.

- **The dispatch and nightly halt** on a red or missing verdict. Get main green; then the next nightly or a manual dispatch applies.

- **`check_only` while main is red:** check reports are dispatch runs too, so the drift diagnostic is unavailable exactly while main is red.

**The gate is ordering, not content.** The apply reads nothing from this checkout but the target list ([where the documents sit](#how-the-apply-works)). So what it guards is the operator's own scripts and the place of the apply behind the sync in a green run.

A red nightly is the signal that drift is going unhealed, so the halt is a FAILED run on purpose.

## Newest wins

**A superseded run's rows stand down GREEN.** Each row asks whether main's tip is still its run's commit ([fleet/newest_main.ts](../../.github/scripts/fleet/newest_main.ts)); when main moved on, the row stands down, and the tip's own run or the nightly applies.

**The plan's refusals are red whatever main's tip is:** a scope naming no repository, or a selected target carrying a hand-written `.github/settings.yml`, fails the run before any row exists.

**Why it asks:** the `settings-repos` lane runs one apply at a time in ARRIVAL order, and CI durations vary, so an older commit's run can reach the lane after a newer one's. post-green.yml's `settings-fleet` job holds the lane on a call; the cron and dispatch runs hold it themselves. Neither cancels a run in progress.

- **Guarantee:** no apply row writes after a row of a newer main commit's run did. An older run's rows wait their turn on the lane and stand down.

- **The one gap:** under [the lane rule](../all-green.md#after-the-gate), a burst can evict the newest commit's pending run behind an older one's. That older run stands down, and the next green push or the nightly applies.

- **A failed look:** a `git ls-remote` that cannot answer fails the row. A guessed "newest" would let a superseded run write; a guessed "superseded" would stand the newest run down.

## How the apply works

A `plan` job, then one `apply (row <i>)` job per target, the shape the sync's operator uses ([platform/sync/operator.md](sync/operator.md)). The selector lists the targets and keys each row of the apply matrix. Every apply job resolves its own target and runs the library's CLI (`gsac`) on it, in `--repos` mode, from its rendered `.github/settings.yml` on its default branch.

- **The row key** is the sync operator's own `rowKeyOf` ([sync/resolve_row.ts](../../.github/scripts/sync/resolve_row.ts)): an HMAC of the slug under the fleet token and the run id, so a private target is identified without being named.

- **One library version:** the bin is the same package the writer folds with ([the merge dialect](../settings.md#the-merge-dialect)), installed by the job's `bun install --frozen-lockfile`. So a `bun update` moves the render and the apply together.

- **One job per target, `fail-fast: false`:** a broken target is its own row's red and never stops another row's apply. The run is red when any row is (a failure, or drift under `check_only`).

- **The apply job never re-runs the plan's probes:** its resolver lists the owner's repositories once and matches the key, so a fleet of N targets costs N listings, not N selections.

- **Bounds:** each apply job is bounded by one target's work, so the fleet's size widens the matrix and never a timeout.

### Selection

A target is selected when all three probes pass, in this order, over every discovered repository the scope admits, sorted:

| Probe    | Reads                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| Enrolled | the fleet token can push to the repository                                                |
| Adopted  | `.repo-platform.yml` on the default branch                                                |
| Rendered | `.github/settings.yml` on the default branch opens with the generator header's first line |

A probe that fails skips the target, save a rendered file without the header, which fails the plan:

- **The hand-written refusal keeps a first sync safe:** a `.github/settings.yml` the sync did not render is never applied on its own. Applying it in `repos` mode would delete every fleet label it does not declare. The plan stays red until the sync PR that renders it merges.

### Private targets

A private target is identified by its row key and named nowhere in the run; how the selector, the matrix, and each apply row keep it out of the public log, and where its report goes, is [private repositories](sync/private-repositories.md#when-the-settings-apply-runs).

### Check mode

**`check_only`** runs every row's CLI in `check`: no setting changes. The one write left is a private target's report issue and its marker label.

A fleet check reads clean only when three things hold together. The second and third readings are what show a stale rendered file behind a held sync PR.

1. every row is green (the CLI exits 1 on drift),
2. the plan skipped no target, and
3. `gh search prs --state open --head automation/repo-platform` finds no sync PR touching `.github/settings.yml`.

## Token

One PAT stored only in repo-platform drives the sync and the central settings ([the README's Credentials section](https://github.com/Vivswan/repo-platform#credentials)). It is strict about permissions: a token that cannot reach a declared section fails that target's apply, so drift never hides behind a green run.
