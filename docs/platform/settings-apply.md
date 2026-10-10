---
order: 265
---

# The settings apply

This page is the central run that applies every managed repository's rendered `.github/settings.yml`: the dispatch scope, the green-commit gate, newest wins, the plan and apply jobs, selection, private targets, check mode, and the token. The settings model (the layers, the dialect, what the apply does to the rendered document) and the run's three entries are [settings.md](../settings.md).

## The dispatch scope

**The `-f repo=` scope** is `all`, or one of these or a comma list of them:

| Scope value | Targets |
|---|---|
| owner/name slugs | those repositories |
| the visibility tokens `public` and `private` | the repositories of that visibility |
| `modules:<a>+<b>` | the targets whose `.repo-platform.yml` selects every listed module; a visibility token intersects with it |

How a scope entry resolves:

| Case | Outcome |
|---|---|
| an entry naming no discovered fleet repository or no module of `files.yml` | fails the run |
| a discovered repository whose push probe is refused, that is not adopted, has no `.repo-platform.yml`, or has no `.github/settings.yml` yet | skipped with a notice |
| a discovered repository carrying a hand-written `.github/settings.yml` | fails the run with a count |

## The green-commit gate

Every run, on all three entries ([when it runs](../settings.md#when-it-runs)), applies only from a GREEN commit ([fleet/require_green_commit.ts](../../.github/scripts/fleet/require_green_commit.ts), the same [all-green predicate](../all-green.md#consuming-the-gate) the tag mover and the sync enforce). Each job has one checkout with no `ref:`, so the selector's and the resolver's code is the judged commit's.

| Entry | The gate |
| --- | --- |
| Post-green call | the sha input must be the run's own judged commit, read through the tag mover's bounded all-green poll (shared/all_green.ts) |
| Dispatch and nightly heal | waits (bounded, 20 minutes) for the tip's all-green check and fails closed on red or none |

- **Post-green call:** the caller is needs-ordered behind the gate in the same run, so a verdict still pending at the bound means the call came from somewhere else.

- **The dispatch and nightly halt:** the run halts with an `::error::` naming the red commit, its verdict, and the fix. Get main green; then the next nightly or a manual dispatch applies.

- **`check_only` while main is red:** check reports are dispatch runs too, so the drift diagnostic is unavailable exactly while main is red.

**The gate is ordering, not content.** The apply reads nothing from this checkout but the target list ([where the documents sit](#how-the-apply-works)). So what it guards is the operator's own scripts and the place of the apply behind the sync in a green run.

A red nightly is the signal that drift is going unhealed, so the halt is a FAILED run on purpose.

## Newest wins

**A superseded run's rows stand down GREEN.** Each row asks whether main's tip is still its run's commit ([fleet/newest_main.ts](../../.github/scripts/fleet/newest_main.ts), one `git ls-remote`). When main moved on, the row stands down with the notice `superseded by <sha>`; the tip's own run or the nightly applies.

**The plan's refusals are red whatever main's tip is:** a scope naming no repository, or a selected target carrying a hand-written `.github/settings.yml`, fails the run before any row exists.

**Why it asks:** the `settings-repos` lane runs one apply at a time in ARRIVAL order, and CI durations vary, so an older commit's run can reach the lane after a newer one's. post-green.yml's `settings-fleet` job holds the lane on a call; the cron and dispatch runs hold it themselves. Neither cancels a run in progress.

**Where it asks:** each row's resolver, before its listing, at the write. No `TARGET` skips the apply step, so a superseded row stands down green. A superseded run's rows each spin up and stand down; a re-run of failed rows asks afresh at each write.

- **Guarantee:** no apply row writes after a row of a newer main commit's run did. An older run's rows wait their turn on the lane and stand down.

- **Under [the lane rule](../all-green.md#after-the-gate):** main runs wait in arrival order and none is cancelled short of 100 pending, so an older run still running when a newer commit lands stands down at its writes, and that newer commit's run applies after it, or the nightly does.

- **A failed look:** a `git ls-remote` that cannot answer fails the row. A guessed "newest" would let a superseded run write; a guessed "superseded" would stand the newest run down.

## How the apply works

A `plan` job, then one `apply (row <i>)` job per target, the shape the sync's operator uses ([platform/sync/operator.md](sync/operator.md)). The selector lists the targets and keys each row of the apply matrix. Every apply job resolves its own target and runs the library's CLI (`gsac`) on it, in `--repos` mode, from its rendered `.github/settings.yml` on its default branch.

| Step | Script | What it does |
| --- | --- | --- |
| plan: select | [fleet/select_settings_repos.ts](../../.github/scripts/fleet/select_settings_repos.ts) | selects the targets ([the three probes](#selection)) |
| apply: resolve | [fleet/resolve_settings_target.ts](../../.github/scripts/fleet/resolve_settings_target.ts) | resolves the row's target |
| apply: apply | `bun run gsac`, the installed library's own bin, `--repos` that one target | applies, or checks, that one target |

- **The selector's outputs** are `count` and `matrix`: one row per target, in the selection's order, each an index and the row's key.

- **The row key** is the sync operator's own `rowKeyOf` ([sync/resolve_row.ts](../../.github/scripts/sync/resolve_row.ts)): an HMAC of the slug under the fleet token and the run id, so a private target is identified without being named.

- **The resolver** asks [newest wins](#newest-wins), then lists the owner's writable repositories once and finds the one the row's key names. It registers every form of the name with the runner's masker before anything else prints, and hands the slug to the CLI through `GITHUB_ENV` (`TARGET`).

- **A key no listed repository carries** (the grant moved mid-run) refuses, naming nothing.

- **The CLI's run:** the log and the step summary (`--summary`) are the job's. A non-zero exit (a failure, or drift under check) is the row's red.

- **One library version:** the bin is the same package the writer folds with ([the merge dialect](../settings.md#the-merge-dialect)), installed by the job's `bun install --frozen-lockfile`. So a `bun update` moves the render and the apply together.

- **One job per target, `fail-fast: false`:** a broken target is its own row's red and never stops another row's apply. The run is red when any row is (a failure, or drift under `check_only`).

- **The apply job never re-runs the plan's probes:** its resolver lists the owner's repositories once and matches the key, so a fleet of N targets costs N listings, not N selections.

- **Bounds:** each apply job is bounded by one target's work (`timeout-minutes: 15`), so the fleet's size widens the matrix and never a timeout. The plan job's bound covers the green gate's wait plus the probes, which run one target after another.

### Selection

A target is selected when all three probes pass, in this order, over every discovered repository the scope admits, sorted:

| Probe | Reads | On failure |
| --- | --- | --- |
| Enrolled | the fleet token can push to the repository | skipped with a notice |
| Adopted | `.repo-platform.yml` on the default branch | skipped with the not-adopted notice; a probe that keeps failing after retries is skipped for the run with a warning and picked up again the next night |
| Rendered | `.github/settings.yml` on the default branch opens with the generator header's first line | a missing file is skipped with the notice `it has no .github/settings.yml yet; the sync PR that renders it has not merged`; a file without the header fails the plan with a count (the log is public, so no name) |

- **The hand-written refusal keeps a first sync safe:** a `.github/settings.yml` the sync did not render is never applied on its own. Applying it in `repos` mode would delete every fleet label it does not declare. The plan stays red until the sync PR that renders it merges.

### Private targets

- **The selector's log** names the public targets and counts the private ones (`settings targets: <public slugs> and <n> private repositories`). Every form of a private slug is registered with the runner's masker before anything prints.

- **The matrix names no target:** a job output holding a masked value is dropped by the runner, and an unmasked slug there would name a private repository in the run's job list. So each row carries the plan's key instead.

- **The key binds the row to its repository:** a repository adopted or revoked mid-run cannot move a row onto another one.

- **In the logs:** a private target appears in its job's log, summary, and outputs as `private repository #1` (`private-repos: redact`). The job's name carries its index in the matrix, `apply (row 3)`, never the repository.

- **A private target's full report** is a reused issue on the target itself, pinned by the `settings-as-code-report` label (`private-report: issue`). It is opened or refreshed when the target fails or drifts, closed when it is healthy, and delivered in check mode too ([private repositories](sync/private-repositories.md)).

- **The first check on a private target** can flag that marker label itself as drift. The label does not exist until the same run's delivery creates it, so the next run is clean.

### Check mode

**`check_only`** runs every row's CLI in `check`: no setting changes. The one write left is a private target's report issue and its marker label.

- **Its output:** one `drift:` line per difference names the section, the field, and the declared versus live values (hidden for a private target, whose detail goes to its report issue).
- **Each row ends** `clean`, `drift`, or `failed`.

A fleet check reads clean only when three things hold together. The second and third readings are what show a stale rendered file behind a held sync PR.

1. every row is green (the CLI exits 1 on drift),
2. the plan skipped no target, and
3. `gh search prs --state open --head automation/repo-platform` finds no sync PR touching `.github/settings.yml`.

## Token

The fleet-level token model lives in the [README's Credentials section](https://github.com/Vivswan/repo-platform#credentials): one PAT stored only in repo-platform drives sync and central settings. It is required there: the central runs fail without it.

- **Strict about permissions:** a token that cannot reach a declared section fails that target's apply (`on-missing-permission: fail`), so drift never hides behind a green run.
- **Required scopes:** Administration and Issues write are required wherever settings are applied.
