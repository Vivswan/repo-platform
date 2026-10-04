---
order: 30
group: Start here
---

# All-green convention

Every repository in the fleet - repo-platform included - gates merges on a required status check named `all-green`: the check run of an ordinary CI job. This page covers the gate, the work that runs after it on main, and repo-platform's fleet-sync label from the PR's side; repo-platform's own post-green run and the gate's residuals are [platform/post-green.md](platform/post-green.md), and setting a repository up is [new-repo.md](new-repo.md).

- **The job** needs every gating job, runs on `if: always()`, and judges the results through [re-actors/alls-green](https://github.com/re-actors/alls-green), a third-party action pinned by sha like every other ([fleet-guidelines.md](fleet-guidelines.md#pinned-actions)).
- **Where it lives:** the managed skeleton's job is in [files/base/.github/workflows/ci.yml](../files/base/.github/workflows/ci.yml); repo-platform's own is in its [ci.yml](../.github/workflows/ci.yml).

**The judgment, whole:** every needed result must be `success`, or `skipped` for a job named in `allowed-skips`. Anything else (`failure`, `cancelled`, a skip the list does not name) fails the gate, and the step summary lists every job with its result.

| ci.yml | `allowed-skips` | Why |
| --- | --- | --- |
| the managed skeleton | `checks` alone | so a schedule night passes on `ci` and an all-skipped run cannot pass |
| repo-platform's own | nothing | since none of its gating jobs may skip |

**The judgment's own scenario tests are alls-green's.** The pin under `files/base` is invisible to Dependabot: bumping alls-green is a hand edit of the skeleton, landed in the fleet by the next sync round.

**repo-platform's own main also requires the pull request branch to be up to date before merging:** the `main-up-to-date` ruleset in its [overlay](../.github/settings.local.yml), with no bypass.

- A stale merge fails at GitHub for admins too (`gh pr update-branch` first).
- A direct push to main is refused unless the commit already carries a passing `all-green` run.
- The fleet does not, because sync and Dependabot pull requests would stall behind every merge.

## Quick triage: why is my PR red or waiting?

Each entry is what you see, what it means, and what to do.

**`all-green` failed; the step summary marks a job with a cross.**

- **Means:** that job's result was not success (or skipped, where the gate allows it).
- **Do:** open the run, fix or re-run the failed job - the re-run re-judges.

**`all-green` shows "Expected" and never arrives.**

- **Means:** the CI run was cancelled or superseded before the gate ran.
- **Do:** push again or re-run the newest CI run at the head.

**`all-green` failed with every job `cancelled`.**

- **Means:** the concurrency group cancelled this run for a newer one at the same head, or someone cancelled it.
- **Do:** the newer run at the head carries the verdict; if none exists or the merge box still reads this run, re-run the newest CI run at the head.

**`all-green` failed with `ci` skipped.**

- **Means:** fleet-ci's `standard-checks` job did not run, so the caller skipped and the gate never lets it.
- **Do:** a run that verified nothing must not merge; check why the caller skipped.

**`pr-title` waiting (repos with the pr-title module).**

- **Means:** its own required check, outside this gate; the workflow re-runs on open/edit/reopen/push ([the pr-title ruleset](settings.md#the-pr-title-ruleset)).
- **Do:** fix the title to what commitlint accepts under config-conventional plus one scope ([the grammar](fleet-guidelines.md#conventional-commits-squash-merged): no scope list, no Sentence-case description, no trailing period).

## What gates what

A managed repository's ci.yml ([the managed file](new-repo.md#3-add-checks-to-checksyml)) carries three gating jobs:

| Gating job | What it does |
| --- | --- |
| `checks` | calls the repo-owned checks.yml; skipped on the nightly schedule run |
| `ci` | calls [fleet-ci.yml](../.github/workflows/fleet-ci.yml)`@stable` with no inputs: the `plan` step of its `standard-checks` job reads `.repo-platform.yml` through [actions/plan](../actions/plan/action.yml), and the job outputs the module selection, visibility, and labels |
| `all-green` | needs both |

**The nightly schedule run** is shared by the two fleet callers. In the `ci` caller, CodeQL reruns on the plan's `weekly` day and the other checks stand down; the `nightly` caller runs the Trivy scan and files its tracking issue.

The jobs beside them gate nothing:

| Non-gating job | What it is |
| --- | --- |
| the `post-green` caller and the static legs | gate-downstream ([after the gate](#after-the-gate)) |
| the schedule-only `nightly` caller of [fleet-nightly.yml](../.github/workflows/fleet-nightly.yml)`@stable` | the nightly [security scan](modules/security-scans.md), public repositories only |

- **Why `nightly` has its own caller:** it runs on the schedule alone and files the tracking issue.
- **Why public only:** a private repository pays for every job that runs, and a skipped job bills nothing.

**The membership rule:** what gates a managed repository is being a job in fleet-ci.yml or checks.yml - a caller job's result aggregates every job of the workflow it calls, so a failure anywhere inside fails the gate.

- **Inside fleet-ci.yml,** a module- or visibility-conditioned step or job skips via its `if:` when it does not apply; a skipped step or job leaves the called run green.

- **The checks every repository runs** are the steps of one `standard-checks` job, because GitHub bills a job a rounded-up minute.

- **Each check step** runs under `!cancelled()` once the plan resolved: one failure never hides another, a cancelled run stops them, and a failed plan runs none. The judge step last ([actions/judge-checks](../actions/judge-checks/action.yml)) fails the job naming every failed check in the log and step summary; a step that stood down is never a failure.

| Step | Runs on | Notes |
| --- | --- | --- |
| `plan` | every event, the schedule included | a failed plan skips every check step (the judge still runs and names it); its outputs gate knip and every job beside |
| `validate-managed-files` | every push and pull request | the action defers its verdict so the findings comment posts first; the `managed-files` step re-raises it |
| `typography`, `file-size`, `commit-names`, `actionlint`, `yamllint`, `typos`, `gitleaks` | every push and pull request | the base checks ([file-size caps](fleet-guidelines.md#file-size-caps)) |
| `zizmor` | every push and pull request | SARIF upload on public repositories only; zizmor exits non-zero alike on an audit error and on a finding, so a failed attempt of either pass runs once more and only the retry's result counts |
| `trivy` | every push and pull request | the blocking half of the [security scans](modules/security-scans.md) |
| `knip` | bun repositories with a package.json to install from | a repository without one yet stands down with a notice |

- **Beside it, one job each:** `semgrep` and `dependency-review` (public repositories only, where minutes are free), `codeql` (a per-language matrix, on public repositories with an analyzable toolchain), and the module jobs `docs-check` and `release-pr`. Each runs under `!cancelled()`, so a red standard check hides none of their verdicts.

- **The `release-pr` job** runs [release-health](../actions/release-health/action.yml) in pull-request mode on the PR head: the head must contain the base tip (a stale release PR would cut a release missing commits already on main), then the health gates run.

- **Bypassing a check:** each check's per-finding bypass is the table in [fleet-guidelines.md](fleet-guidelines.md#how-to-bypass-a-check).

- **Repo-platform's own ci.yml** has no callers to hide behind: its gating jobs are the needs list itself.

- **Its skills checks:** `validate-skills` (structure, offline) and `skills-discovery` (the real `npx skills` listing, so its own job) run [Vivswan/skills' validate-skills action](https://github.com/Vivswan/skills/tree/main/.github/actions/validate-skills) on this repository's own skills catalog. The action is pinned by sha like every other third-party action ([fleet-guidelines.md](fleet-guidelines.md#pinned-actions)).

- **Its docs shape and wording check:** the `docs-check` job runs [Vale](https://vale.sh) over README.md and every page under docs/ with the skills repository's styles, read from a checkout at the validate-skills sha: a paragraph or list item over 70 words, or a word or phrase from the unslop and natural-writing skills' lists, fails the job, naming the line. The binary is a pinned release verified by sha256, as pinact is.

- **Its docs path check, CI-only like Vale:** the same job runs the docs-discipline probe from that checkout over the same pages; `bun run check` does not. A relative link whose target is missing fails it. A backticked path fails it when its first directory exists beside the page, at the root, or in `files/base` and the rest does not; bare file names and other layouts are left alone.

- **A repo-owned advisory check** opts out with `continue-on-error: true` on its job in checks.yml.

## Consuming the gate

Anything that asks "is this commit green" reads the CHECK RUN, never the CI run's conclusion (a run whose gating job was skipped still concludes success).

- **One implementation:** [shared/all_green.ts](../.github/scripts/shared/all_green.ts), shared by the [stable tag mover](platform/build-provenance.md), the sync's delivery-commit gate, and the [settings green-commit gate](platform/settings-apply.md#the-green-commit-gate).
- **The poll:** consumers that wake on their own (a dispatched tag move, the sync) can race a fresh check, so the read polls briefly before failing closed. The unwedge for a missing check is re-running the sha's CI run - the gate job posts the check.

## After the gate

Post-gate work rides downstream in the same run, `needs: [all-green]` on a push to main, so `github.sha` IS the judged commit.

**Every push to main gets its own complete run:** ci.yml's group is keyed by the commit on a push and by the ref on a pull request (where a newer push cancels the stale run). So no merge timing cancels or coalesces another commit's run. Keyed by the ref, GitHub kept one pending run per group and replaced it with the newest, which left a burst's middle commits unjudged.

**The lane rule:** the runs of neighbouring commits therefore overlap, and the legs that mutate shared state serialize on their job lanes (`stable-tag-move`, `sync-repos`, `settings-repos`, `pages`). On a lane, GitHub keeps one running plus one pending job and replaces the pending one with the newest, in arrival order rather than commit order.

Repo-platform's own run after the gate (the tag mover, the fleet sync and settings legs, the fleet token) is [platform/post-green.md](platform/post-green.md#the-run-leg-by-leg).

### The post-green hook in every managed repository

**Every managed ci.yml carries a `post-green` job** calling the repo-owned starter `post-green.yml` (workflow_call only, seeded once, never resynced) with the judged sha: the repository's own green-gated work goes there - applying settings, refreshing generated artifacts.

- The caller passes every repository secret through and holds no concurrency lane of its own: the repo's jobs take theirs, and a caller holding a lane a called job needs deadlocks the call against itself.

- A lane on any job the `release` job needs (the repo's post-green hook included) must be keyed per commit: under [the lane rule](#after-the-gate), a burst of merges can evict the release commit's pending job and strand its tag until a re-run.

**The caller grants `GITHUB_TOKEN` two scopes,** the ceiling for every hook job (a called job cannot raise above its caller), and no knob narrows them per repository:

| Scope | Why |
| --- | --- |
| `contents: write` | a hook may publish a fast-forward branch such as a packaged `latest` |
| `id-token: write` | a hook may mint the run's OIDC token for trusted publishing (npm, PyPI). GitHub artifact attestations need `attestations: write` too, which this ceiling does not grant |

**The starter ships one no-op job** (a workflow_call cannot ship empty), and that job costs a runner allocation on every green push to main until the repository REPLACES it. Replace the no-op, do not append beside it.

**Every hook job must be state-based and idempotent,** since the runs of neighbouring commits overlap ([after the gate](#after-the-gate)): act on the repository's current state, never on "what this commit changed".

**Never key a concurrency group in the hook on `github.workflow`:** inside a called workflow it resolves to the caller's name, so `<workflow>-<sha>` on a push is the lane the calling run already holds, and a job waiting on it deadlocks the run.

**A failing hook job blocks the release, never the merge.**

### The static legs

```text
checks + ci -> all-green -> post-green (repo-owned hook) -> release -> update-release (hook) -> publish-release -> site
                                                                  \-> update-release-pr (hook)
```

**The legs after the hook are STATIC:** every managed ci.yml carries the same `release`, `update-release`, `publish-release`, `update-release-pr`, and `site` jobs, present in every run, and each skips where its module is not selected.

- Adding a module needs no change to ci.yml ([changing the module selection](new-repo.md#changing-the-module-selection)).
- How each leg's condition is spelled in the managed ci.yml, and which lanes the release cut holds, is [platform/post-green.md](platform/post-green.md#how-the-static-legs-gate).

**The `release` leg** needs the gate AND the hook, so the repo's post-green work lands before the tag is minted. It then calls [fleet-release.yml](../.github/workflows/fleet-release.yml)`@stable` with the judged sha and fleet-ci's `tracking-labels` output. The called job takes two paths off release-health's `release-cut` output:

| Push | Path |
| --- | --- |
| a release-PR merge | it cuts: release-please tags that merge commit (never the branch head) and drafts the release, whatever main does afterwards |
| every other push | it proposes or refreshes the release PR, and only while main's head is still the judged commit (release-health's `head-current` output): a run whose commit is no longer the head skips instead of racing the newer run's refresh |

- **A release merge whose own run went red** stays pending until that run is re-run, and the stale-label guard (release-health in `after-propose` mode, run once release-please proposed) names it on the next push.

- **Known limit:** two release PRs merged before either is cut are both tagged by the first cut run, since release-please builds every pending release PR.

- **Known limit:** when a release merge and an ordinary push land within one run's span, the ordinary run's release-PR refresh can abort green while the merged release PR still wears `autorelease: pending`; the first push after the cut has relabelled it tagged refreshes the PR again.

**Its outputs drive the release hooks** `update-release`, `publish-release`, and `update-release-pr`; [the release pipeline](new-repo.md#the-release-pipeline-release-please) owns what each one does, and why the two repo-owned hooks are seeded in every repository whatever its modules.

**The `site` leg** calls [reusable-site.yml](../.github/workflows/reusable-site.yml)`@stable` with the judged sha, holding the `pages` lane ([site.md](modules/site.md)). The called workflow runs the repo-owned `.github/actions/site-build` hook from the checkout and reads the docs configuration from the repository's registration.

- The leg has no push clause: it runs on every main run whose gate passed, so the nightly schedule is the rebuild and a dispatch is the manual deploy, and no site workflow of its own exists.

- It is ordered behind `publish-release` as an ORDER and not a gate: its condition leads with `!cancelled()`, so it waits for the release legs and then deploys whatever their result (a red hook skips the release; the deploy still runs). A release commit's own deploy serves its new tag.

### Opting a PR into an immediate fleet sync

One label on the PR, before it merges.

| Label | Syncs now | Notes |
| --- | --- | --- |
| `fleet-sync:public` | every public managed repo | the default choice |
| `fleet-sync:all` | the whole fleet, the same run the weekly cron performs | private repos burn paid Actions minutes, so the weekly sync normally carries them |

- **A direct push:** a commit no pull request produced carries no label and never syncs from its own merge.

- **A refused label:** two fleet-sync labels on one PR, or a `fleet-sync:` label the platform does not declare, turn `read-directives` red on the judged commit and nothing syncs. A mistyped opt-in fails loudly instead of waiting for Tuesday.

- **The fix for a refused label:** fix the merged PR's labels for the next run that covers the commit (every run reads [the whole range](platform/post-green.md#which-commits-a-run-reads)), dispatch the sync by hand (`gh workflow run sync-repos.yml -f repo=...`), or let the next merge carry a correct label.

- **Dispatch-only scopes:** `private`, repository slugs, and the `modules:<a>+<b>` filter ([the README's `repo=` table](../README.md#shipping-a-change)). The leg unions the labels of every commit in its range, and an intersecting token would misread there: a `public, modules:site` beside a `private` would read as every repo selecting site and drop the private repos the second asked for.

- **The settings apply never depends on the label,** since every green run applies every target.

- **How the leg reads the label,** which commits a run reads, and the bot that labels a platform PR by default are [platform/post-green.md](platform/post-green.md#how-the-leg-reads-the-label).
