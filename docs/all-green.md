# The all-green convention

Every repository in the fleet - repo-platform included - gates merges on a required status check named `all-green`: the check run of an ordinary CI job. [ci.yml](../.github/workflows/ci.yml)'s `all-green` job needs every gating job, runs on `if: always()`, and judges the results through the shared [actions/all-green](../actions/all-green/action.yml) composite (rendered repos pin it `@build`, this repo calls it by local path):

```yaml
all-green:
  needs: [checks, ci]        # every gating job - a rendered repo's two caller jobs
  if: always()               # a failed dependency must FAIL the gate, not skip it
  steps:
    - uses: Vivswan/repo-platform/actions/all-green@build
      with:
        needs: ${{ toJSON(needs) }}
```

The judgment, whole: every needed result must be `success` or `skipped` (a module- or visibility-conditioned job stands down by skipping), with at least one `success` - an all-skipped run vouches for nothing. Anything else (`failure`, `cancelled`) fails the gate.

## Quick triage: why is my PR red or waiting?

| Symptom | Cause | Fix |
| --- | --- | --- |
| `all-green` failed naming a job | That job's result was not success/skipped | Open the run, fix or re-run the failed job - the re-run re-judges. |
| `all-green` shows "Expected" and never arrives | The CI run was cancelled or superseded before the gate ran | Push again or re-run the newest CI run at the head. |
| `all-green` failed with "no gating job actually succeeded" | Everything the gate needs skipped | A run that verified nothing must not merge; check why the callers skipped. |
| `pr-title` waiting (repos with the pr-title module) | Its own required check, outside this gate | Fix the title to a Conventional Commit; the workflow re-runs on open/edit/reopen/push ([the pr-title ruleset](settings.md#the-pr-title-ruleset)). |

## What gates what

- A managed repository's ci.yml carries three gating jobs: `checks` (calls the repo-owned checks.yml), `ci` (calls [fleet-ci.yml](../.github/workflows/fleet-ci.yml)`@build` with the module selection), and `all-green` needing both - plus the gate-downstream `post-green` caller ([after the gate](#after-the-gate)), which gates nothing. The membership rule: what gates a managed repository is being a job in fleet-ci.yml or checks.yml - a caller job's result aggregates every job of the workflow it calls, so a failure anywhere inside fails the gate.
- Inside fleet-ci.yml, module- and visibility-conditioned jobs skip via job-level `if:` when they do not apply; a skipped job leaves the called run green. The base checks there (`typography`, `file-size` ([new-repo.md](new-repo.md#file-size-caps)), `commit-names`, `actionlint`, `yamllint`, and `gitleaks`) are the steps of one `base-checks` job for every visibility: each step runs under `!cancelled()` so one failure never hides another (a cancelled run stops them), and the last step fails the job naming every failed check in the log and step summary. It sits beside `validate-template` and the module jobs. Repo-platform's own ci.yml has no callers to hide behind: its gating jobs are the needs list itself.
- A repo-owned advisory check opts out with `continue-on-error: true` on its job in checks.yml (the retired verdict's `info-*` naming opt-out died with it).

## The rosters (how a deleted gate stays loud)

The gate judges only what its `needs` list names, so a job deleted from ci.yml AND from the needs list would stop gating silently. Authored rosters in [scripts/check_ssot.ts](../scripts/check_ssot.ts) close that at authoring time:

| Rule | What it pins |
| --- | --- |
| `all-green-roster` | Repo-platform's ci.yml: the gating job set, the gate's needs list, and `ALL_GREEN_ROSTER` held together in every direction, plus the gate's `if: always()` and `toJSON(needs)` wiring. |
| `fleet-ci-roster` | fleet-ci.yml's job set, both directions - deleting `codeql` there would drop the gate for every managed repository at once - and no job-level `continue-on-error` (a softened fleet job would read green to every caller's gate; `file-size` softens its own step inside `base-checks`). |
| `fleet-ci-render-roster` | The rendered ci.yml's shape at [the source](https://github.com/Vivswan/repo-platform/blob/main/templates/base/.github/workflows/ci.yml.jinja): exactly the `checks`/`ci`/`all-green`/`post-green` jobs, the gate's exact lines, the post-green caller's condition block, judged-sha pass, `contents: read` ceiling, and absence of a lane, and the release leg's condition block (gate AND hook), judged-sha pass, and concurrency lane. |
| `all-green-name` | The check NAME, pinned once as data: the ruleset's required context (Actions-pinned by `integration_id`), the `all-green` job id at both sources, `all_green.ts`'s CHECK_NAME, and the sentence this page opens with. |

## Consuming the gate

Anything that asks "is this commit green" reads the CHECK RUN, never the CI run's conclusion (a run whose gating job was skipped still concludes success). [shared/all_green.ts](../.github/scripts/shared/all_green.ts) is the one implementation, shared by the [build publisher](build-provenance.md), the sync's stamped-source gate, and the [settings green-commit gate](settings.md#when-it-runs):

- Checks posted by the retired verdict workflow and the pre-inversion aggregate job satisfy the same read, so history stays green; the verdict era's `external_id` blocklist still rejects its pull_request checks.
- Consumers that wake on their own (a dispatched build publish, the sync) can race a fresh check, so the read polls briefly before failing closed. The unwedge for a missing check is re-running the sha's CI run - the gate job posts the check.

## After the gate

Post-gate work rides downstream in the same run, `needs: [all-green]` on a push to main, so `github.sha` IS the judged commit:

- Repo-platform's `post-green` job calls [post-green.yml](../.github/workflows/post-green.yml), whose publish job composes the judged commit's tree in that run and advances the `build` branch - re-verifying the check at the source commit before any mutation ([build-provenance.md](build-provenance.md)). post-green.yml's only other way in is a `workflow_dispatch` with a green main commit's `sha`, which runs the publish leg alone: the self-heal for a publish that failed or was evicted after its gate passed (the next push heals it too; a sync meanwhile renders the previous build). The file's header has the coalescing contract every leg there must satisfy.
- Its `read-directives` leg reads the directives block of every commit since the last published build (the range two bullets down), and when a PR in that range opted in, `sync-fleet` calls sync-repos.yml in the same run, needs-ordered behind the publish, holding the `sync-repos` lane the weekly cron also holds. The opt-in grammar is below.
- Its `settings-fleet` leg calls settings-repos.yml for every target on every called run, with no diff deciding it: the apply is idempotent and reads each target's own state, so a run that changed no settings input is an early nightly heal: it fixes whatever out-of-band drift its targets carry and nothing else. It is needs-ordered behind `sync-fleet` whatever that leg's result (skipped, green or red), so a repo synced in this run is applied right after its sync, and it holds the `settings-repos` lane the nightly cron also holds. The called run gates on the judged commit through the publisher's bounded all-green poll ([settings.md](settings.md#the-green-commit-gate)).
- The directives leg reads from the build tip's stamped source to the judged commit ([fleet/judged_range.ts](../.github/scripts/fleet/judged_range.ts)), not the push's own `before..sha` or the judged commit alone: ci.yml keeps one pending main run and a newer push evicts it, so a push superseded in that slot never gets a run of its own, and its successor's own range would miss it. The last published green main is a durable base with no new state, covers every commit since it (superseded pushes included), and may lag several commits when the composed tree did not change - that only widens the range, and the read is idempotent over it. The build tip may already be this very run's publish, so the leg takes the newest stamp older than the judged commit. A stamped source that is not an ancestor of the judged commit is refused, and so is a build branch with no stamp anywhere (publish.ts stamps every commit, so nothing else may have written it); only a missing build branch, or one whose every stamp is the judged commit itself (the first publish ever, landed by this run), falls back to the push payload's `before`, with a notice.
- A skipped publish skips the sync (the build it would ship is stale) and nothing else: the settings apply reads no build branch, so it still runs, exactly as it does on a call with no directive.
- Both fleet writers reach the fleet this way and never from a `push`: the `fleet-writers-ride-post-green` rule pins each one's triggers to schedule, dispatch, and the post-green call, the call's sha and lane plumbing, and the caller census - post-green.yml's leg is each writer's only caller, and ci.yml's `post-green` job is post-green.yml's, both in the same-commit `./` spelling. The writer roster itself is held against the fleet PAT: every workflow reading `secrets.REPO_PLATFORM_TOKEN` is a registered writer or a classified non-writer, so an unregistered fleet-mutating workflow cannot land silently.
- Every rendered ci.yml carries a `post-green` job calling the repo-owned starter `post-green.yml` (workflow_call only, seeded once, never resynced) with the judged sha: the repository's own green-gated work goes there - applying settings, refreshing generated artifacts. The caller caps `GITHUB_TOKEN` at `contents: read` (a called job cannot raise above its caller) and passes every repository secret through, and holds no concurrency lane of its own: the repo's jobs take theirs, and a caller holding a lane a called job needs deadlocks the call against itself.
- The starter ships one no-op job (a workflow_call cannot ship empty), and that job costs a runner allocation on every green push to main until the repository REPLACES it. Replace the no-op, do not append beside it.
- Hook jobs run for the LATEST green main, not for every commit: ci.yml's main group never cancels a running run (`cancel-in-progress` holds only for pull requests), but GitHub keeps one running plus one pending run per group and replaces the pending one, so a commit's hook is skipped when a third push lands while one run is in progress and one is pending. Every hook job must therefore be state-based and idempotent: act on the repository's current state, never on "what this commit changed".
- Never key a concurrency group in the hook on `github.workflow`: inside a called workflow it resolves to the caller's name, so `<workflow>-<ref>` is the lane the calling run already holds, and a job waiting on it deadlocks the run. A failing hook job blocks the release, never the merge.
- On release-please repos, the rendered ci.yml's `release` leg needs the gate AND the hook, so the repo's post-green work lands before the tag is minted, then calls the managed release pipeline the same way ([new-repo.md](new-repo.md#the-release-pipeline-release-please)), holding the `post-green-release` lane; release.yml's head gate skips when main has moved on.

```text
checks + ci -> all-green -> post-green (repo-owned hook) -> release (release-please module)
```

### Opting a PR into an immediate fleet sync

The PR body OPENS with a directives block: its first paragraph is one bracketed directive per line and nothing else; a bracket-only line may be fenced in one pair of backticks so it renders as code, and a justified `all` line is written bare (a code span followed by text is prose). Squash merges put the body right under the subject verbatim, so the merged commit carries the block and post-green reads it from git alone.

```text
`[fleet-sync: public]`

## How

...
```

| Scope line | Syncs now | Notes |
| --- | --- | --- |
| `[fleet-sync: public]` | every public managed repo | the default choice |
| `[fleet-sync: private]` | the private ones | private repos burn paid Actions minutes, so the weekly sync normally carries them |
| `[fleet-sync: public, owner/a, owner/b]` | the union of tokens and public repo slugs | slugs name PUBLIC repos only |
| `[fleet-sync: all] <justification>` | the whole fleet, the same run the weekly cron performs | the reason is required, on the same line, and generic; this line is written bare, since a code span followed by text is prose |

- Case does not matter, and `` `[fleet-sync: public]` `` reads the same as `[fleet-sync: public]`. The bare `[fleet-sync]` form is retired with no compatibility: it is the all-scope without its justification and turns the leg red.
- The justification says what changed and why every repo needs it now, naming no private repository: `[fleet-sync: all] the all-green gate action changed for every ci.yml`.
- The leg passes the tokens through as written; sync-repos.yml's plan, the one place that knows each repo's visibility, expands `public` and `private` against discovery and refuses a scope that names a private repo by slug (counts only, never the slug): `sync-fleet` goes red and nothing syncs. [fleet/sync_scope.ts](../.github/scripts/fleet/sync_scope.ts) owns the grammar for the leg and both writers' plans.
- A body whose first paragraph is not a block carries no directives; git trailers GitHub appends on squash (`Co-authored-by:`) change nothing.
- The parser scans the WHOLE merged message. A mention wrapped in a code span (`` `[fleet-sync: public]` `` in prose: a backtick run closed by the next run of the same length, as in CommonMark) is prose, so describe the grammar that way. A span may cross line breaks inside its paragraph (GitHub wraps the squash body at 72 columns, so a long span in the PR body arrives as several lines) but never a blank line or a fence line; a run without its closer is not a span, a fence line (three or more backticks or tildes) opens a code block rather than a span, and a bare `[fleet-sync` anywhere else, even inside a fenced code example, is a misplaced directive.
- The mention scan reads each line behind its leading whitespace and blockquote markers, in any mix, and a line that is only markers (`>`) is a paragraph break: a fenced example quoted with `> ` is still a fence and a quoted code span is still a span. The block itself is written at the start of the line, unquoted and unindented; a quoted or indented directive is a misplaced directive, and an error quotes the line as written.
- A bare `[fleet-sync` (outside a code span) or a bracket-only paragraph anywhere else in the body or in the PR title (the squash subject is the title), backtick fencing that is not one pair, an unknown or repeated keyword, an empty scope, an entry that is neither a slug nor a token, an all-scope without its justification, or a justification on any other scope turns `read-directives` red and nothing syncs: a mistyped opt-in fails loudly instead of waiting for Tuesday. A block at the BOTTOM of the body, where the retired grammar put it, is the misplaced case and goes red the same way. The merged commit cannot be edited, so dispatch the sync by hand (`gh workflow run sync-repos.yml -f repo=...`) or let the next merge carry a correct block.
- The block is public text on `main`, and so is every log line that echoes it: private repositories appear there only as the word `private`; the plans print them by their masked hint.
- The leg reads every commit since the last published build, so an opt-in survives its own CI run's eviction. Three PRs merged within one minute, `[fleet-sync: public]` on the first only, and only the third's run reaches post-green:

```text
::notice::fleet-sync directive on <first merge>: public
::notice::<last published build>..<third merge> opted in: syncing public now
```

- Several opt-ins in the range union: any `all` wins, otherwise the lists combine into one set, order-insensitive (the plans select by membership): within a line the tokens come first, then the slugs, folded and deduped; across commits, first appearance wins. A red body on the judged commit turns the leg red and nothing syncs; an older commit's red body already failed its own run, so here it is a warning naming the commit and contributes nothing, and the next merge's correct block still syncs.
- A merge loses its OWN run only when a third merge lands while one run is in progress and one is pending (GitHub replaces the pending run; a running main run is never cancelled), and the surviving run's range still reads its directive. The opt-in is lost only when no later green run reaches post-green before the cron, or when the first-publish fallback reads the push alone: the weekly sync cron heals it. The settings apply never depends on the directive, since every green run applies every target.

## Residuals, stated

- A PR can still gut a called workflow's content (checks.yml is repo-owned) or hand-condition the managed `ci` caller away; the sync-time validator errors on a conditioned caller, validate-template's integrity check blocks managed-file edits, and review owns the rest - the same same-repo residual every check has.
- Any workflow in this repository could mint a look-alike `all-green` check run (the Actions app pin does not distinguish jobs). The repo is its own sole workflow author; the roster rules and review own that surface.
- Copilot code review is advisory: the `copilot_code_review` rule requests a review on every public-repo PR, but nothing blocks on it ([settings.md](settings.md#copilot-code-review)).
