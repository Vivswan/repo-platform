# The all-green convention

Every repository in the fleet - repo-platform included - gates merges on a required status check named `all-green`, the one context that stands for CI as a whole. Since the verdict inversion, `all-green` is not a CI job: it is a CHECK RUN that a `workflow_run`-triggered verdict workflow creates after judging the completed CI run's jobs.

Branch protection (the fleet override layer's `main` ruleset - see docs/settings.md) requires exactly ONE context - `all-green` - so the required-checks list never changes as jobs and expectations come and go. The Copilot review expectation lives inside the verdict (the Copilot section below), not as a second context.

## Quick triage: why is my PR pending or red?

| Symptom | Cause | Fix |
| --- | --- | --- |
| Verdict shows `in_progress`, summary names an owed Copilot review | Copilot's `copilot-pull-request-reviewer` check has not succeeded at the judged head yet | Wait for the review; if none fires, re-request Copilot's review from the reviewers panel - its submission re-judges on its own. |
| Draft PR stuck pending on the review | Pushes to a draft get no automatic review run (correct semantics - drafts do not merge) | Mark the PR ready, then request the review (one click in the reviewers panel) if none arrives on its own. |
| Bot-authored PR (Dependabot) stuck pending | Copilot does not auto-review bot PRs, and CI-completion wakes cannot see the PR author | Submit or re-request ANY review after CI completes - the review wake reads the bot author and stands the expectation down. |
| Red CI run, gate needs refreshing | The verdict fires on run completion | "Re-run failed jobs": the re-run's completion fires a fresh verdict over the newest attempts. |
| No `all-green` check at the sha at all | Normal while the CI run is still going or the just-completed run's verdict is still queued; abnormal when no check appears after that - the `workflow_run` event was lost or the verdict run itself was swallowed | Give the verdict a moment after CI completes; if the check still never lands, dispatch the `All Green` workflow with the sha (the unwedge path below). |
| Pending verdict whose missing member already landed | A conditional workflow completing, a fork-headed PR's review, or a review that raced Copilot's still-concluding check fires no usable wake | Same dispatch unwedge. |
| Verdict FAILED naming duplicate display names | Two distinct gating jobs share one name, so a failure could hide behind a same-named success | Rename the colliding jobs (repo-owned checks.yml is the usual source) and re-run. |
| Verdict failed: no succeeded `ci / validate-template` | The managed ci.yml's fleet-ci caller was deleted, conditioned away, or renamed under `info-` | Restore the managed ci.yml (the next template sync rewrites it) and re-run. |
| One All Green run per week goes red on repo-platform | The weekly SCHEDULED CI run's completion wakes the verdict, and with an expected set declared the verdict refuses `schedule`/`workflow_dispatch` judgments outright | Expected, not a bug: it posts nothing, and the push verdict at the same sha is untouched. |
| The sync PR that INTRODUCES all-green.yml never goes green | The bootstrap gap: only the merged copy of the workflow can ever run | One-time admin-bypass merge (the bootstrap section below). |

## What fires when

| Wake | Trigger | What happens |
| --- | --- | --- |
| CI completion | The CI run completes, with ANY conclusion | The verdict judges the WHOLE sha (the event is only a wake-up) and posts a fresh `all-green` check run - refused judgments (below) post nothing. |
| Review submission | `pull_request_review` (types: `submitted`) on the client-side wrapper | Re-judges the reviewed PR's current head - this is what closes the loop on an owed Copilot review, because a check run's completion fires no `workflow_run` event. |
| Dispatch | `workflow_dispatch` with a sha | The unwedge: re-judges the newest completed CI run at the sha and posts the check as if the event had just arrived. |

Every wake judges ONCE and exits; no runner is ever held waiting.

## The verdict

The judgment lives once, in `.github/workflows/reusable-all-green.yml`: repo-platform's own `.github/workflows/all-green.yml` calls it by local path, and every managed repository's thin managed `all-green.yml` wrapper calls it at the green-gated `@build` ref. The wrapper must live client-side because a `workflow_run` trigger only runs a workflow's copy in the same repository AND on its default branch; the logic living centrally means a verdict fix reaches the fleet without a sync PR.

What a gating job's conclusion does to the verdict:

| Conclusion | Effect |
| --- | --- |
| `success` | Passes. |
| `skipped` | STANDS DOWN - how module- and visibility-conditioned jobs opt out per run. |
| `failure`, `cancelled`, `timed_out`, `neutral`, `action_required`, `stale` | Fails the verdict. |

Every job is GATING unless a ` / `-separated segment of its name starts with `info-` (naming a caller job `info-*` opts out every job of the workflow it calls).

How the judgment reads the run, and where it fails closed:

- It lists ALL attempts of the CI run's jobs and judges each job's newest attempt (grouped by name): a partial re-run's newest attempt alone lists only the jobs it re-ran, which would lose every verdict-relevant job that concluded earlier.
- Two distinct gating jobs sharing one display name within an attempt fail closed (the name is the only identity stable across attempts, so a failure could otherwise hide behind a same-named success): rename the colliding jobs - repo-owned checks.yml is the usual source - and re-run.
- The caller-pinned ANCHOR job must have succeeded: the managed wrapper passes `require-job: ci / validate-template`, so a run whose fleet-ci caller was deleted, conditioned away, or renamed under `info-` never passes on the repo-owned checks alone (every other fleet gate lives inside that one repo-editable caller).
- No gating job concluding `success` fails closed - an empty or all-skipped run vouches for nothing - and so does a triggering run that is not the real `.github/workflows/ci.yml` or has not completed.
- On `pull_request` judgments, it also judges the EXPECTED SET the caller declared beyond the CI run itself (the next section).
- It creates the `all-green` check run via `POST /repos/{owner}/{repo}/check-runs` with `head_sha` set to the CI run's own head sha. That explicit sha is load-bearing: any check a `workflow_run`-triggered run's own JOBS create attaches to that run's default-branch checkout, so only the explicit `head_sha` puts the verdict into the PR merge box.

The trade against the old aggregate job: a skipped job no longer BLOCKS, so an accidental job-level `if:` on a gate fails open at run time. That hazard moved to authoring time - repo-platform's gating jobs are pinned unconditional by the roster rule below, and the fleet's job conditions are authored centrally in fleet-ci.yml, behind repo-platform's own gauntlet.

## The expected set

A repository can owe more than its CI run on a pull request, and the reusable's inputs declare what.

### `conditional-workflows` (JSON list of workflow display names, default `[]`)

Each name is bound to ITS ONE registered workflow:

- The repository's workflow registry (default-branch state) must know the name and resolve it to exactly one path, and every candidate run at the judged sha - read from ALL workflow runs there, never just the triggering one - must come from that path.
- An unknown name, a name two workflows claim, or a run from any other path fails closed, so a same-named decoy never satisfies the roster.
- The owning workflow's newest `pull_request` run must conclude `success` (a `skipped` run stands down, like a skipped job); registered but not yet run keeps the verdict PENDING, never green.

What remains, deliberately:

- The registry is default-branch state, so a rostered workflow introduced, renamed, or moved in the SAME PR fails the verdict until that change lands on the default branch (merge it first, then roster it).
- A PR gutting the registered workflow file at its own path still passes - the standing same-repo residual that review owns, like gutting any check.

Fleet wiring:

- The managed wrapper passes this input GENERATED from the module manifests' `conditional_workflows` declarations (`templates/<module>/module.yml`, spliced by compose_template.ts's data anchor, gated on the owning module's selection).
- A declarable workflow must produce a run on EVERY `pull_request` event - a paths- or types-filtered one would keep the verdict pending on every PR it skips.
- No shipped module workflow qualifies today, so every render carries `'[]'` until one does.
- The manifest loader holds each declaration against the module's shipped workflow file and its `name:` line, and refuses two-claimant names outright.

### `require-copilot-review` (bool, default false)

Expect Copilot's `copilot-pull-request-reviewer` check run (Actions-created, like all-green itself) as a completed success at the judged sha - unless the PULL REQUEST'S AUTHOR is a bot (`Bot` type or a `[bot]` login), because Copilot does not auto-review bot-authored PRs (the Copilot section below).

- The author is deliberately the only key: a run-actor key once let a bot-triggered re-run at a human PR's head disarm the gate for one round.
- The author rides the `pull_request_review` event's payload; every other wake has no author within the callers' `checks: write` + `actions: read` grant (resolving the PR needs a pulls read those permissions do not carry), and an UNKNOWN author keeps the expectation ARMED - unknown can disarm nothing.
- Absent or still running keeps the verdict pending; a completed non-success fails it.

### How a pending verdict resolves

There is no poll and no wait input: the verdict judges once and exits. A check run's completion fires no `workflow_run` event, so the wake that closes the loop is Copilot's own review SUBMISSION - the wrapper's `pull_request_review` (types: `submitted`) trigger calls the verdict with the reviewed PR's current head, and the fresh judgment finds the check.

- Any submitted review is a wake. A human review on a bot-authored PR is how that PR's armed-by-unknown-author expectation gets resolved: the review wake carries the author, reads it as a bot, and stands the expectation down.
- A review wake judges only the newest PULL_REQUEST-event CI run at the head - a same-sha push or dispatch run must not flip the judgment to CI-only semantics.
- A review wake stands down quietly when there is nothing judgeable: no PR run yet, or the newest one still in flight (judging an older completed run would mint a stale green while a retrigger's outcome is unknown); the CI run's own completion judges later.
- Ordering residual on bot-authored PRs, recorded: a review submitted before CI completes is such a discarded wake, and the later CI wake carries no author, so the expectation stays armed - the heal is one more review, or the Copilot re-request, after CI completes.
- A review wake on a fork-headed PR stands down too (those wakes carry a read-only token; the sha's CI-completion wakes judge with full permissions, and a review landing after the last CI completion there needs the dispatch unwedge).
- One race is accepted: a review wake can arrive while Copilot's check run is still concluding, leaving a pending verdict that the next wake or the unwedge replaces.

### Pending, push, and refused judgments

When the expected set is incomplete but nothing is red, the verdict posts the `all-green` check as `in_progress` - visibly pending in the merge box, with a summary naming exactly what is missing - instead of a conclusion, and exits.

- Every wake re-judges the sha idempotently and posts the current answer: each CI completion there, and each submitted review (which is how the owed Copilot review replaces the pending check the moment it lands). A conditional completing fires no wake of its own, so a later CI completion or the dispatch unwedge covers it.
- Push judgments owe only the CI run: main's green gates must never wait on PR-shaped members.
- Judgments of any OTHER event - `workflow_dispatch`, `schedule`, or an event type that does not exist yet - refuse outright while an expected set is declared: such a run can neither carry nor stand down PR-scoped members, so judging it CI-only would mint green over a red conditional. The refusal fails the verdict JOB without posting any check, so a legitimate verdict from the sha's real run is never shadowed; with nothing declared, those events keep posting CI-only verdicts as before.

One stated bound of the current design: the verdict wakes on CI completions and review submissions, so a conditional workflow that re-runs AFTER a verdict landed does not re-judge the sha on its own. The wrapper's `workflow_run` subscription list is the seam that would close this; until it does, the dispatch unwedge is the heal.

The retired poll's stale-snapshot bound went with the poll: every wake is one fresh read of every member, so nothing is ever judged from a pre-wait snapshot.

The remaining contract lines:

- Expectations are event-scoped fail-closed the same way verdicts are consumed: only runs of the judged event satisfy a member, and non-PR judgments carry no expected set.
- The reusable exposes what it posted as a `conclusion` workflow_call output (`success`/`failure`, empty when pending), so a caller sequencing work on the gate tests `== 'success'` instead of proxying the triggering run's conclusion, which can be green while the verdict itself fails.
- The expected-set computation lives twice by necessity (the reusable's steps must stay inline - it runs in the caller's repository): the inline jq/bash, pinned by the `verify_verdict_judgment.sh` harness, and its executable twin `expectedSetGaps` in `shared/all_green.ts`, pinned by bun tests.
- Repo-platform's own caller passes `require-copilot-review: true` (the Copilot section below) and no `conditional-workflows` - its roster is authored (`ALL_GREEN_ROSTER` below), so its CI-shaped expected set is the CI run alone.

## The roster

The runtime verdict judges only the jobs that RAN, so it cannot notice a gate that was deleted from ci.yml. Authored rosters in `scripts/check_ssot.ts` close that hole at authoring time:

| Roster | What it pins | The rule |
| --- | --- | --- |
| `ALL_GREEN_ROSTER` | repo-platform's own ci.yml job set, compared both directions (a new job must be rostered; a removed job must have its entry deleted in the same change, deliberately); job-level `if:` and `name:` are forbidden on gating jobs there. | `all-green-roster` |
| `FLEET_CI_ROSTER` | fleet-ci.yml's job set, both directions - deleting `dependency-review` or `codeql` there would otherwise drop the gate for every managed repository at once; `info-*` job ids and `name:` overrides are banned outright, while job-level `if:` stays allowed (module and visibility conditioning is the design). | `fleet-ci-roster` |

A managed repository's own ci.yml needs no roster: its whole gate is the one fleet-ci caller, which the verdict's `require-job` anchor makes load-bearing at run time (above), the render validator requires unconditional under the verdict shape, and integrity validate-template re-enforces at sync time.

The TEMPLATE side is pinned the same way, at the source, so a fleet-wide drift is one loud diff instead of ten sync PRs:

- The `all-green-wrapper-template` rule pins the managed wrapper's shape (`WRAPPER_TEMPLATE_PINS`): the trigger set including the review wake, the per-sha concurrency group, the grants, the visibility-split `require-copilot-review` expression, and the conditional-workflows anchor.
- The same rule runs a both-ways input census against the reusable's declared inputs (a retired input lingering in the wrapper would fail every fleet `workflow_call` at once; a new input silently unpassed would ride its default fleet-wide) and bans the retired `copilot-wait-minutes` anywhere.
- The `fleet-ci-render-roster` rule pins the release leg's render at its source: the template ci.yml may carry exactly the `checks` and `ci` caller jobs and no fragment anchor beyond the with-block data anchors (a job re-added there would gate every repo, or splice past the census), and the wrapper's release leg must keep its verbatim verdict gate, its judged-sha pass, and its own concurrency lane - dropping any clause would release off unjudged or red commits.

The check NAME is pinned once as data by the `all-green-name` rule: the string the ruleset requires (`.github/settings-override.yml`, the sole required context), the string the verdict reports (`reusable-all-green.yml`), the string the green gates look up (`shared/all_green.ts` CHECK_NAME), and the name this document quotes must all be the same `all-green`, provably, at authoring time.

The same rule pins the verdict call's `require-copilot-review: true` and pins the override's required-check list to exactly `all-green`: since the cutover, the verdict input is the review gate's ONLY home, so a silent regression to the input's false default - or the retired Copilot context creeping back into the ruleset - must go red at authoring time.

## Consuming the verdict

Anything that asks "is this commit green" reads the CHECK RUN, never the CI run's conclusion: a run whose gating job was skipped still concludes `success`, so the run conclusion fails open. `shared/all_green.ts` is the one implementation (the build publisher and the sync's stamped-source gate share it):

- It lists the sha's `all-green` check runs by name with `filter=latest`, accepts only checks the `github-actions` app created, rejects checks whose recorded event (the verdict stamps the judged run's event into `external_id`) is a pull_request - a PR run tests the synthetic merge tree, never the sha's own tree - and passes on any completed success.
- Checks created by the retired aggregate JOB satisfy the same read (the event filter is a blocklist because their external_ids are opaque), so commits vouched for before the inversion stay green.
- The green-path build publish is ORDERED behind the verdict (the post-green section below), but the other readers - the schedule/dispatch self-heal publish and the sync's stamped-source gate - wake on their own and can race a re-judged sha's fresh verdict, so the read polls briefly under `ALL_GREEN_WAIT_MS` before failing closed.
- Pending (in_progress) verdicts exist only for `pull_request` judgments - the expected set is PR-scoped - and PR verdicts never vouch here anyway, so the green gates only ever see completed push verdicts.

The release pipeline follows the same rule with a different delivery. ONE rule: nothing happens off a commit unless its whole run was green.

- Consumers OUTSIDE the run - the merge gate, build promotion, the sync's stamped-source gate - read the posted `all-green` check run, because they cannot see inside the run.
- The release-please module's release leg rides the managed `all-green.yml` wrapper itself: `needs: [verdict]` gated on the verdict's POSTED conclusion (`needs.verdict.outputs.conclusion == 'success'`) for a push-to-main run - the same rule, delivered as the verdict's own output rather than a check-run read, exactly the shape of repo-platform's own post-green job below. One deliberate delta from the retired in-run `needs: [checks, ci]` edge: `needs` also held release back when a nested repo-owned `info-*` job failed, which the verdict waves through - the verdict IS the gate's definition now, so an opted-out job's failure no longer blocks release. The second: `workflow_dispatch` CI runs no longer trigger a release - the retired job fired on push OR dispatch to main, the leg only on push verdicts.

Same rule, one enforcement point per consumer; the leg's shape is pinned by check_ssot.ts's fleet-ci-render-roster rule (templates/release-please/fragments/all-green-release.jinja is the source).

## Post-green: what runs after the gate

On a green verdict for a push-to-main CI run, repo-platform's `all-green.yml` releases a `post-green` job - `needs: [verdict]`, gated on `needs.verdict.outputs.conclusion == 'success'` plus the event data pinning push-to-main - which calls `.github/workflows/post-green.yml`, the one home for everything that runs after green on main. Its trigger is `workflow_call` alone: the verdict is the only way in.

Today it hosts one leg, the build-branch publish (moved from Build Branches' retired `workflow_run` leg). Build Branches keeps the push-time pending build and its schedule/dispatch legs as the publish SELF-HEAL, since the dispatch unwedge below re-judges but never publishes.

Concurrency is two nested resources, deliberately distinct. The calling job holds `post-green-<branch>` (releases serialize per branch; verdicts stay per-sha), while the called publish job takes the repo-scoped literal `build-branches-publish` - the SINGLE publisher lane it shares by name with Build Branches' self-heal legs, so every writer of `refs/heads/build` serializes in one queue across both workflows.

The lane name is a literal on purpose: `github.workflow` inside a `workflow_call`'d workflow resolves to the CALLER's name and would silently split the lane. And the caller must never hold the resource its called workflow requires - the two names differing is what makes the call unable to deadlock against itself. (Rider: GitHub documents concurrency groups as repo-scoped across workflows, but the cross-workflow sharing has not yet been observed live here.)

Every post-green leg must be STATE-shaped: GitHub keeps at most one running plus one pending run per group and replaces the pending one (latest wins), so a superseded pending leg must either be covered by its evictor or leave at most a staleness its next trigger or the weekly cron repairs.

The publish leg qualifies: publish.ts publishes the judged commit behind a newest-green-wins staleness preflight onto an append-only branch whose plain push is the compare-and-swap, so reruns are no-ops and the out-of-order-eviction residual is staleness-only. A leg that cannot tolerate a swallowed pending run does not belong in a coalescing lane.

## The unwedge path

If a verdict never lands at a sha - the `workflow_run` event was lost, or the verdict run itself was swallowed - the gate stays missing and everything fails closed. Dispatch the `All Green` workflow with the sha: it re-judges the newest completed CI run there (whole expected set included) and posts the check as if the event had just arrived.

The same dispatch heals a PENDING verdict whose missing member landed without a wake: a conditional workflow completing when no later CI completion follows, a fork-headed PR's review (those review wakes stand down), or a review wake that raced Copilot's still-concluding check run.

## The bootstrap gap

The sync PR that INTRODUCES `all-green.yml` is unverdictable by construction: the default-branch constraint above means only the merged copy of the workflow can ever run, and that copy does not exist until this very PR merges - the `workflow_dispatch` unwedge runs under the same constraint, so it cannot help there either.

The path is a one-time admin-bypass merge. The sync PR carries a note naming it when it detects the transition (the update delivers the workflow and the target's default branch lacks it), and stays on the manual-review path because its required check can never appear.

It self-heals immediately: every later PR is judged by the merged copy, so the bypass happens once per absent-to-present transition of the workflow - once per repository, unless the file is later deleted out of band.

## Single-call fleet CI

A managed repository's `.github/workflows/ci.yml` no longer describes its own CI. It carries two jobs: `checks`, calling the repo-owned `.github/workflows/checks.yml` (`_skip_if_exists`, edit freely), and `ci`, calling `repo-platform/.github/workflows/fleet-ci.yml@build` with the repo's recorded module selection, visibility, and the derived `codeql-languages` / `skills-dir` / `tracking-labels` inputs.

THE MEMBERSHIP RULE: what gates a managed repository is being a job in fleet-ci.yml (plus checks.yml) - an edit to fleet-ci or to an action changes fleet CI with no per-repo diff trail, and repo-platform's own CI gating every such edit is the counterweight.

Inside fleet-ci.yml, module- and visibility-conditioned jobs carry job-level `if:` guards and skip when they do not apply (the verdict reads skipped as standing down):

- The five base checks fan out per job on public repositories and merge into one `base-checks` job on private ones (each tiny job would otherwise bill a rounded-up minute).
- `dependency-review` is public-PR-only.
- `codeql` runs a per-language matrix over the `codeql-languages` input.
- The `pr-title`, `validate-skills`, `release-freshness`, and `release-health` module jobs condition on the `modules` input.

Reusable workflows prefix job names ("ci / pr-title"), which is harmless: a job name carries no required-check meaning any more - the verdict reads names only for the `info-` opt-out prefix.

Repos that select release-please carry a `release` leg in the managed all-green.yml wrapper (it must call the repo-owned release.yml by local path): `needs: [verdict]`, released only when the verdict POSTED success for a push-to-main run, holding its own `post-green-release` concurrency lane (a name no job inside release.yml takes - the caller sharing its called job's group would self-deadlock). The leg passes the JUDGED commit into release.yml's `sha` input, because `github.sha` on a workflow_run event is main's current tip - possibly a newer commit whose own verdict is still pending - and release.yml's head gate compares that judged commit against the tip, skipping (not failing) when main moved on. Because the wrapper is workflow_run-triggered, it executes the default branch's copy: the leg goes live on the first push to main after the sync PR delivering it merges.

In the repo-owned checks.yml, a job skipped by its own `if:` stands down rather than failing the gate; name a job `info-*` to keep even its failures out of the gate, and put checks that need secrets or more than `contents: read` in their own workflow.

Release health is enforced twice on purpose. The fleet-ci `release-health` job fails the release PR early and visibly, but a PR-time check can go stale: a tracking or `release-blocker` issue opened after the PR turned green re-runs nothing, so the managed release.yml re-runs the same action as the authoritative pre-flight before release-please acts.

In release mode the gate self-scopes to the push that merges a release-please PR - it reads the `release-override` label from that merged PR (the label waves through EVERY release-health gate at once, loudly), and ordinary main pushes and release-PR refreshes are never blocked.

Adding `release-override` to the release PR does not re-trigger CI (ci.yml does not run on `labeled`): re-run the failed release-health job after labeling; the release-time pre-flight reads the label on its own.

### validate-template: two verdicts, different consequences

The whole fleet-ci job body is the `validate-template-report` composite action, which wraps the `validate-template` integrity action with the freshness compare and the reporting, so the fleet-ci job is a thin caller keeping only what an action cannot carry (the job-scoped `pull-requests: write` and the fail-last step reading the action's `integrity` output).

| Verdict | What it checks | Consequence |
| --- | --- | --- |
| INTEGRITY | The tree against the state it was stamped with (the wrapped action). | A failure means managed content changed outside a sync: BLOCKS on pull requests and main pushes alike. Fix: restore the file from history, or run a recovery sync. |
| FRESHNESS | One ref compare against repo-platform's `build` branch tip - no copier, no render. | Only reports how far behind the repository is - never its fault, never its blocker, because the next sync PR closes it. Failures (network, or an operator repo the token cannot read) skip with a notice rather than going red. |

How the results reach you:

- On a pull request both verdicts go in ONE comment, found by a marker so a later push updates it rather than posting another, and posted BEFORE the job fails so a blocking result is readable in the conversation instead of only in the run log. A clean, fresh repository leaves no new comment but still clears one a previous run left behind.
- On a push both go to the job summary.
- The integrity action's exit code is untouched (the wrapper defers it, then re-raises it through its output) and still blocks its other consumers directly: the operator repo's own `--self` run and the sync pipeline.

## Waiting for Copilot: the verdict-owned review expectation

Copilot code review executes as a dynamic Actions workflow (`dynamic/agents/copilot-pull-request-reviewer`), and each run creates a check run named `copilot-pull-request-reviewer` on the PR's CURRENT head sha, concluding when the review posts. The VERDICT owns the expectation of that check: repo-platform's own all-green.yml passes `require-copilot-review: true`, and the managed fleet wrapper renders it from the repo's visibility - `true` on public repositories, `false` on private ones.

THE VISIBILITY SPLIT is load-bearing, not cosmetic: Copilot reviews are disabled on the fleet's private repos, so an unconditional expectation would leave every private PR's verdict pending on a reviewer that can never come (the pending state has no expiry by design), and the `copilot_code_review` auto-request rule lives in the fleet's PUBLIC settings overlay for the same reason.

Where the expectation holds, a pull-request verdict is not green until Copilot's check succeeded at the judged head (the expected-set section above has the full semantics, the author-based bot stand-down included).

There is no gate job, no re-run and no re-arm machinery: a push re-judges through its CI run's completion, the `copilot_code_review` rule triggers a fresh review run for the new head (`review_on_push: true`), and the review's SUBMISSION is its own wake. The ruleset's required review thread resolution polices the review's content; the verdict's expectation polices only that the review of the current head happened.

Until the cutover the ruleset ALSO required the `copilot-pull-request-reviewer` context directly, next to `all-green` - the belt while the verdict-owned form was proven on repo-platform. That context is retired: the verdict owns the expectation everywhere now, and `all-green` is the sole required context.

`loadOverrideLayer` refuses an override document that drops that context or its `integration_id` pin to the GitHub Actions app (15368) - the app that creates the verdict's check run - so no other app and no plain commit status can satisfy the context by name, and the fleet cannot lose the gate by accident. (The residual: a workflow job named `all-green` is also an Actions-created check run, so the pin does not defend against a same-repo workflow spoofing the name. That residual predates this design; the verdict's check-name collision guard and review own it.)

An earlier design note here claimed requiring the Copilot context blocks every PR forever because its check suite never reached the merge-box rollup. That described the retired delivery: Copilot's review used to report through its own app's check suite, which GitHub never attached to the PR rollup. Since Copilot code review moved onto Actions, the check run is an ordinary Actions check run on the head sha - fleet evidence shows it created and completing per push, repo-platform and managed repos alike.

Two residuals of the verdict-owned form, observed on repo-platform first:

- The stand-down keys on the PR AUTHOR, which only review wakes carry, so a bot-authored PR judged through CI completions alone stays PENDING until a review is submitted after CI completes (one manual review request resolves it - the same single click those PRs needed under the retired ruleset context).
- With an expected set declared the verdict refuses `schedule`/`workflow_dispatch` judgments outright - repo-platform's CI has a weekly scheduled run, so ONE All Green run per week goes red at that wake and posts nothing. That weekly red is the expected instance of the fail-closed shape, not a bug; the push verdict at the same sha is untouched.

Verified edges, and what they cost:

- New pushes to non-draft PRs get an automatic review run each (observed seven consecutive heads on one PR, each with its own completed run). No action needed.
- DRAFT PRs: pushes to a draft get no automatic review run despite `review_draft_pull_requests: true`, so a draft's verdict stays pending on the owed review. Correct semantics - drafts do not merge - and marking the PR ready plus requesting the review (one click in the reviewers panel, if none arrives on its own) satisfies it.
- BOT-authored PRs (Dependabot): Copilot does not auto-review them (verified on merged fleet Dependabot PRs - no check run ever appeared), and the verdict cannot see the author from a CI-completion wake, so the verdict stays pending until one review is submitted after CI completes - Copilot's (re-requested manually) or any human's, whose review wake reads the bot author and stands the expectation down. The blockage is deliberate: nothing merges unreviewed, and the click IS the review request.
- If a review run fails or never fires, re-requesting Copilot's review from the reviewers panel starts a fresh run for the current head; its submission re-judges the verdict on its own. At most one manual action, always the same one.

Repos outside the settings sync (no settings-sync module, or excluded in repos.yml) have no managed ruleset, so the required check does not bind them - same scope as every other fleet protection.
